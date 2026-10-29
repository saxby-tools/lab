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

const SALT_KEY = "\x00secretstore\x00salt\x00";
const SECRET_PREFIX = "\x00secretstore\x00sec\x00";

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Retrieve or create the PBKDF2 salt
  let salt: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);
  if (storedSalt === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bytesToBase64(salt));
  } else {
    salt = base64ToBytes(storedSalt);
  }

  // Derive a 256-bit AES-GCM key from the master password
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  function makeSecretKey(owner: string, name: string): string {
    return (
      SECRET_PREFIX +
      bytesToBase64(enc.encode(owner)) +
      "\x01" +
      bytesToBase64(enc.encode(name))
    );
  }

  function makeOwnerPrefix(owner: string): string {
    return SECRET_PREFIX + bytesToBase64(enc.encode(owner)) + "\x01";
  }

  // Build unambiguous AAD from owner + name (length-prefixed to avoid
  // collisions when either string contains the delimiter byte).
  function makeAAD(owner: string, name: string): Uint8Array {
    const o = enc.encode(owner);
    const n = enc.encode(name);
    const aad = new Uint8Array(8 + o.length + n.length);
    const dv = new DataView(aad.buffer);
    dv.setUint32(0, o.length, false);
    dv.setUint32(4, n.length, false);
    aad.set(o, 8);
    aad.set(n, 8 + o.length);
    return aad;
  }

  async function put(
    owner: string,
    name: string,
    value: string,
  ): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = makeAAD(owner, name);
    const plaintext = enc.encode(value);

    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      aesKey,
      plaintext,
    );

    // Store IV || ciphertext as a single base64 blob
    const combined = new Uint8Array(12 + ciphertextBuf.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertextBuf), 12);

    const key = makeSecretKey(owner, name);
    await storage.set(key, bytesToBase64(combined));
  }

  async function get(
    owner: string,
    name: string,
  ): Promise<string | undefined> {
    const key = makeSecretKey(owner, name);
    const stored = await storage.get(key);
    if (stored === undefined) return undefined;

    try {
      const combined = base64ToBytes(stored);
      // Minimum: 12-byte IV + 16-byte GCM tag
      if (combined.length < 28) {
        throw new Error("corrupt data");
      }
      const iv = combined.subarray(0, 12);
      const ciphertext = combined.subarray(12);
      const aad = makeAAD(owner, name);

      const plaintextBuf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        ciphertext,
      );
      return dec.decode(plaintextBuf);
    } catch {
      throw new Error("Tamper detected: unable to decrypt secret");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = makeOwnerPrefix(owner);
    const allKeys = await storage.keys();
    const names: string[] = [];

    for (const k of allKeys) {
      if (k.startsWith(prefix)) {
        const nameB64 = k.slice(prefix.length);
        names.push(dec.decode(base64ToBytes(nameB64)));
      }
    }

    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = makeSecretKey(owner, name);
    const stored = await storage.get(key);
    if (stored === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}

// --- base64 helpers (no external imports) ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
