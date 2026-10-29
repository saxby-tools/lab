export interface KeyValueStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface SecretStoreOptions {
  storage: KeyValueStorage;
  masterPassword: string;
}

export interface SecretStore {
  put(owner: string, name: string, value: string): Promise<void>;
  get(owner: string, name: string): Promise<string | undefined>;
  list(owner: string): Promise<string[]>;
  remove(owner: string, name: string): Promise<boolean>;
}

const SALT_KEY = "__secret_store_salt__";
const SECRET_PREFIX = "secret:";
const IV_LEN = 12;
const GCM_TAG_LEN = 16;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    let chunk = "";
    for (let j = i; j < end; j++) {
      chunk += String.fromCharCode(bytes[j]);
    }
    binary += btoa(chunk);
  }
  return binary;
}

function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes (owner, name) into a base64 blob so that the storage key is
 * unambiguous regardless of the characters in owner / name.
 * Layout: [uint32-BE ownerLen][owner UTF-8][name UTF-8]
 */
function encodeOwnerName(owner: string, name: string): string {
  const enc = new TextEncoder();
  const ownerBytes = enc.encode(owner);
  const nameBytes = enc.encode(name);
  const buf = new Uint8Array(4 + ownerBytes.length + nameBytes.length);
  new DataView(buf.buffer).setUint32(0, ownerBytes.length, false);
  buf.set(ownerBytes, 4);
  buf.set(nameBytes, 4 + ownerBytes.length);
  return toBase64(buf);
}

function decodeOwnerName(encoded: string): { owner: string; name: string } | undefined {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(encoded);
  } catch {
    return undefined;
  }
  if (bytes.length < 4) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ownerLen = dv.getUint32(0, false);
  if (4 + ownerLen > bytes.length) return undefined;
  const dec = new TextDecoder("utf-8", { fatal: true });
  try {
    const owner = dec.decode(bytes.subarray(4, 4 + ownerLen));
    const name = dec.decode(bytes.subarray(4 + ownerLen));
    return { owner, name };
  } catch {
    return undefined;
  }
}

function makeSecretKey(owner: string, name: string): string {
  return SECRET_PREFIX + encodeOwnerName(owner, name);
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // --- Salt (per-store, stored in the KV backend) ---
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  let salt: Uint8Array;
  try {
    salt = fromBase64(saltB64);
  } catch {
    throw new Error("Corrupted salt in storage");
  }

  // --- Derive AES-256 key via PBKDF2 ---
  const passwordBytes = new TextEncoder().encode(masterPassword);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derivedBits,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

  // --- Public API ---

  async function put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const valueBytes = new TextEncoder().encode(value);
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      valueBytes,
    );
    const combined = new Uint8Array(IV_LEN + ciphertextBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertextBuf), IV_LEN);
    await storage.set(makeSecretKey(owner, name), toBase64(combined));
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const key = makeSecretKey(owner, name);
    const stored = await storage.get(key);
    if (stored === undefined) return undefined;

    let combined: Uint8Array;
    try {
      combined = fromBase64(stored);
    } catch {
      throw new Error("Invalid secret data");
    }

    // Minimum: 12-byte IV + 16-byte GCM tag (empty plaintext)
    if (combined.length < IV_LEN + GCM_TAG_LEN) {
      throw new Error("Invalid secret data");
    }

    const iv = combined.subarray(0, IV_LEN);
    const ciphertext = combined.subarray(IV_LEN);

    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        ciphertext,
      );
    } catch {
      throw new Error("Tamper detected");
    }

    return new TextDecoder().decode(plaintext);
  }

  async function list(owner: string): Promise<string[]> {
    const allKeys = await storage.keys();
    const names: string[] = [];
    for (const k of allKeys) {
      if (!k.startsWith(SECRET_PREFIX)) continue;
      const parsed = decodeOwnerName(k.slice(SECRET_PREFIX.length));
      if (parsed !== undefined && parsed.owner === owner) {
        names.push(parsed.name);
      }
    }
    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = makeSecretKey(owner, name);
    const existing = await storage.get(key);
    if (existing === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}
