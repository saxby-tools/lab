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

const SALT_KEY = "\u0000__secret_store_salt\u0000";
const SECRET_PREFIX = "\u0000__secret_store_secret\u0000";
const PBKDF2_ITERATIONS = 100_000;

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Obtain or create the PBKDF2 salt in storage.
  let saltHex = await storage.get(SALT_KEY);
  if (saltHex === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltHex = toHex(salt);
    await storage.set(SALT_KEY, saltHex);
  }

  // Derive a 256-bit AES-GCM key from the master password.
  const salt = fromHex(saltHex);
  const passwordBuf = new TextEncoder().encode(masterPassword);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBuf,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key: CryptoKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  function makeSecretKey(owner: string, name: string): string {
    const encOwner = toBase64(new TextEncoder().encode(owner));
    const encName = toBase64(new TextEncoder().encode(name));
    return `${SECRET_PREFIX}${encOwner}:${encName}`;
  }

  async function put(
    owner: string,
    name: string,
    value: string,
  ): Promise<void> {
    const sk = makeSecretKey(owner, name);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(value);
    // Bind the ciphertext to the exact storage key so that copying a
    // record to a different owner/name pair will fail authentication.
    const aad = new TextEncoder().encode(sk);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plaintext,
    );
    const record = JSON.stringify({
      iv: toHex(iv),
      ct: toHex(new Uint8Array(ciphertext)),
    });
    await storage.set(sk, record);
  }

  async function get(
    owner: string,
    name: string,
  ): Promise<string | undefined> {
    const sk = makeSecretKey(owner, name);
    const raw = await storage.get(sk);
    if (raw === undefined) return undefined;

    // Parse and validate the record structure.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Corrupted secret record");
    }

    if (
      typeof parsed !== "object" || parsed === null ||
      !("iv" in parsed) || !("ct" in parsed) ||
      typeof (parsed as Record<string, unknown>).iv !== "string" ||
      typeof (parsed as Record<string, unknown>).ct !== "string"
    ) {
      throw new Error("Corrupted secret record");
    }

    const rec = parsed as { iv: string; ct: string };

    let iv: Uint8Array;
    let ct: Uint8Array;
    try {
      iv = fromHex(rec.iv);
      ct = fromHex(rec.ct);
    } catch {
      throw new Error("Corrupted secret record");
    }

    if (iv.length !== 12) {
      throw new Error("Corrupted secret record");
    }

    const aad = new TextEncoder().encode(sk);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        ct,
      );
    } catch {
      throw new Error("Secret integrity check failed");
    }

    return new TextDecoder().decode(plaintext);
  }

  async function list(owner: string): Promise<string[]> {
    const allKeys = await storage.keys();
    const prefix =
      `${SECRET_PREFIX}${toBase64(new TextEncoder().encode(owner))}:`;
    const names: string[] = [];
    for (const k of allKeys) {
      if (k.startsWith(prefix)) {
        const encodedName = k.slice(prefix.length);
        try {
          names.push(new TextDecoder().decode(fromBase64(encodedName)));
        } catch {
          // Skip keys that are not in our format (attacker-injected).
        }
      }
    }
    names.sort();
    return names;
  }

  async function remove(
    owner: string,
    name: string,
  ): Promise<boolean> {
    const sk = makeSecretKey(owner, name);
    const existing = await storage.get(sk);
    if (existing === undefined) return false;
    await storage.delete(sk);
    return true;
  }

  return { put, get, list, remove };
}

// ---------- helpers ----------

function toHex(bytes: Uint8Array): string {
  const parts: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return parts.join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const start = i * 2;
    const byte = parseInt(hex.slice(start, start + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Invalid hex string");
    bytes[i] = byte;
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
