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

const SALT_KEY = "_meta/salt";
const SECRET_PREFIX = "secret/";
const INDEX_PREFIX = "index/";
const PBKDF2_ITERATIONS = 100_000;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

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

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256(data: BufferSource): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

function makeKeyData(owner: string, name: string): Uint8Array {
  const enc = new TextEncoder();
  const ownerBytes = enc.encode(owner);
  const nameBytes = enc.encode(name);
  const total = 4 + ownerBytes.length + 4 + nameBytes.length;
  const data = new Uint8Array(total);
  const view = new DataView(data.buffer);
  view.setUint32(0, ownerBytes.length, false);
  data.set(ownerBytes, 4);
  view.setUint32(4 + ownerBytes.length, nameBytes.length, false);
  data.set(nameBytes, 8 + ownerBytes.length);
  return data;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Obtain or create the PBKDF2 salt so a new store over the same
  // storage + password derives the identical AES key.
  let saltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(32));
    saltB64 = bytesToBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  } else {
    salt = base64ToBytes(saltB64);
  }

  const cryptoKey = await deriveKey(masterPassword, salt);

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // --- key helpers -------------------------------------------------------

  async function secretStorageKey(
    owner: string,
    name: string,
  ): Promise<string> {
    const data = makeKeyData(owner, name);
    const hash = await sha256(data);
    return SECRET_PREFIX + toHex(hash);
  }

  async function indexStorageKey(owner: string): Promise<string> {
    const hash = await sha256(enc.encode(owner));
    return INDEX_PREFIX + toHex(hash);
  }

  // AAD binds ciphertext to its (owner, name) so an attacker cannot
  // copy one secret's blob onto another key and have it decrypt.
  async function aadFor(
    owner: string,
    name: string,
  ): Promise<Uint8Array> {
    return await sha256(makeKeyData(owner, name));
  }

  async function readIndex(owner: string): Promise<string[]> {
    const key = await indexStorageKey(owner);
    const raw = await storage.get(key);
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      // corrupted index – treat as empty
    }
    return [];
  }

  async function writeIndex(
    owner: string,
    names: string[],
  ): Promise<void> {
    const key = await indexStorageKey(owner);
    await storage.set(key, JSON.stringify(names));
  }

  // --- public API --------------------------------------------------------

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const sk = await secretStorageKey(owner, name);
      const aad = await aadFor(owner, name);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
      const plaintext = enc.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad },
        cryptoKey,
        plaintext,
      );

      // Layout: nonce (12 B) ‖ ciphertext+tag (n + 16 B)
      const combined = new Uint8Array(NONCE_LENGTH + ciphertext.byteLength);
      combined.set(nonce, 0);
      combined.set(new Uint8Array(ciphertext), NONCE_LENGTH);

      await storage.set(sk, bytesToBase64(combined));

      // Keep the per-owner name index up to date.
      const names = await readIndex(owner);
      if (!names.includes(name)) {
        names.push(name);
        await writeIndex(owner, names);
      }
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const sk = await secretStorageKey(owner, name);
      const raw = await storage.get(sk);
      if (raw === undefined) return undefined;

      let combined: Uint8Array;
      try {
        combined = base64ToBytes(raw);
      } catch {
        throw new Error("Stored secret data is corrupted");
      }

      // Minimum valid blob: 12-byte nonce + 16-byte GCM tag (empty plaintext).
      if (combined.length < NONCE_LENGTH + TAG_LENGTH) {
        throw new Error("Stored secret data is corrupted");
      }

      const nonce = combined.subarray(0, NONCE_LENGTH);
      const ciphertext = combined.subarray(NONCE_LENGTH);
      const aad = await aadFor(owner, name);

      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad },
          cryptoKey,
          ciphertext,
        );
        return dec.decode(plaintext);
      } catch {
        throw new Error("Decryption failed: secret may have been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const names = await readIndex(owner);
      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const sk = await secretStorageKey(owner, name);
      const raw = await storage.get(sk);
      if (raw === undefined) return false;

      await storage.delete(sk);

      const names = await readIndex(owner);
      const filtered = names.filter((n) => n !== name);
      if (filtered.length !== names.length) {
        await writeIndex(owner, filtered);
      }

      return true;
    },
  };
}
