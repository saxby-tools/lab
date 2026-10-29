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

export function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  return createStore(options.storage, options.masterPassword);
}

// ─── constants ────────────────────────────────────────────────────────────────

const SALT_KEY = "\x00__ss_salt__\x00";
const SECRET_PREFIX = "secret\x00";
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 100_000;
const HASH = "SHA-256";
const KEY_LENGTH = 256;

// ─── base64 helpers (no imports needed) ───────────────────────────────────────

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

function encodeKeyPart(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

function decodeKeyPart(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

// ─── key derivation ───────────────────────────────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: HASH,
    },
    baseKey,
    { name: "AES-GCM", length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── store implementation ─────────────────────────────────────────────────────

async function createStore(
  storage: KeyValueStorage,
  masterPassword: string,
): Promise<SecretStore> {
  // Obtain or create the PBKDF2 salt (persisted in storage)
  const existingSaltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (existingSaltB64 !== undefined) {
    try {
      salt = base64ToBytes(existingSaltB64);
    } catch {
      salt = crypto.getRandomValues(new Uint8Array(32));
      await storage.set(SALT_KEY, bytesToBase64(salt));
    }
  } else {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await storage.set(SALT_KEY, bytesToBase64(salt));
  }

  const cryptoKey = await deriveKey(masterPassword, salt);

  // Build the storage key for a given (owner, name) pair.
  // Base64-encoding each component guarantees no \x00 appears in the
  // encoded form, so the \x00 separators are unambiguous.
  function secretStorageKey(owner: string, name: string): string {
    return `${SECRET_PREFIX}${encodeKeyPart(owner)}\x00${encodeKeyPart(name)}`;
  }

  function ownerPrefix(owner: string): string {
    return `${SECRET_PREFIX}${encodeKeyPart(owner)}\x00`;
  }

  // The AAD binds the ciphertext to the specific (owner, name) so that
  // copying another secret's blob to this location will fail authentication.
  function aadFor(owner: string, name: string): Uint8Array {
    return new TextEncoder().encode(secretStorageKey(owner, name));
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const plaintext = encoder.encode(value);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
        cryptoKey,
        plaintext,
      );
      // Layout: [ iv (12 bytes) | ciphertext+tag (variable) ]
      const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), IV_LENGTH);
      await storage.set(secretStorageKey(owner, name), bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const stored = await storage.get(secretStorageKey(owner, name));
      if (stored === undefined) return undefined;

      let data: Uint8Array;
      try {
        data = base64ToBytes(stored);
      } catch {
        throw new Error("Corrupted secret data");
      }

      if (data.length < IV_LENGTH) {
        throw new Error("Corrupted secret data: too short");
      }

      const iv = data.slice(0, IV_LENGTH);
      const ciphertext = data.slice(IV_LENGTH);

      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
          cryptoKey,
          ciphertext as unknown as BufferSource,
        );
        return decoder.decode(plaintext);
      } catch {
        throw new Error("Decryption failed: secret data may have been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = ownerPrefix(owner);
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const encoded = k.slice(prefix.length);
          try {
            names.push(decodeKeyPart(encoded));
          } catch {
            // Skip keys that don't decode (tampered / foreign keys)
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const k = secretStorageKey(owner, name);
      const stored = await storage.get(k);
      if (stored === undefined) return false;
      await storage.delete(k);
      return true;
    },
  };
}
