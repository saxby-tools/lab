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

/* ---------- constants ---------- */

const SECRET_PREFIX = "\x00secret\x00";
const SALT_KEY = "\x00meta\x00salt";
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN = 256;

/* ---------- base64 helpers ---------- */

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function base64ToBytes(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function stringToBase64(str: string): string {
  return bytesToBase64(new TextEncoder().encode(str));
}

function base64ToString(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

/* ---------- key / aad helpers ---------- */

function storageKey(owner: string, name: string): string {
  return SECRET_PREFIX + stringToBase64(owner) + "\x00" + stringToBase64(name);
}

function ownerPrefix(owner: string): string {
  return SECRET_PREFIX + stringToBase64(owner) + "\x00";
}

/**
 * Length-prefixed AAD so that (owner, name) pairs are unambiguous
 * regardless of the characters they contain (including NUL).
 */
function makeAad(owner: string, name: string): Uint8Array {
  const o = new TextEncoder().encode(owner);
  const n = new TextEncoder().encode(name);
  const aad = new Uint8Array(8 + o.length + n.length);
  const dv = new DataView(aad.buffer);
  dv.setUint32(0, o.length, false);
  dv.setUint32(4, n.length, false);
  aad.set(o, 8);
  aad.set(n, 8 + o.length);
  return aad;
}

/* ---------- key derivation ---------- */

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
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
    material,
    { name: "AES-GCM", length: KEY_LEN },
    false,
    ["encrypt", "decrypt"],
  );
}

/* ---------- public API ---------- */

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Ensure a PBKDF2 salt exists in storage.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }

  // Deriving the key may throw (e.g. attacker corrupted the salt),
  // in which case createSecretStore rejects as required.
  const encKey = await deriveKey(masterPassword, base64ToBytes(saltB64));

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const path = storageKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
      const aad = makeAad(owner, name);
      const plaintext = new TextEncoder().encode(value);

      const ctBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        encKey,
        plaintext,
      );

      // Layout: [ iv (12) | ciphertext + GCM tag ]
      const combined = new Uint8Array(IV_LEN + ctBuf.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ctBuf), IV_LEN);

      await storage.set(path, bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const path = storageKey(owner, name);
      const stored = await storage.get(path);
      if (stored === undefined) return undefined;

      try {
        const combined = base64ToBytes(stored);
        if (combined.length < IV_LEN + TAG_LEN) {
          throw new Error("ciphertext too short");
        }
        const iv = combined.subarray(0, IV_LEN);
        const ct = combined.subarray(IV_LEN);
        const aad = makeAad(owner, name);

        const ptBuf = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          encKey,
          ct,
        );
        return new TextDecoder().decode(ptBuf);
      } catch {
        throw new Error("Integrity check failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = ownerPrefix(owner);
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const b64Name = k.slice(prefix.length);
          try {
            names.push(base64ToString(b64Name));
          } catch {
            // Skip attacker-inserted keys with unparseable names.
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const path = storageKey(owner, name);
      const existing = await storage.get(path);
      if (existing === undefined) return false;
      await storage.delete(path);
      return true;
    },
  };
}
