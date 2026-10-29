/**
 * Secret store implementation for Deno 2.
 * Provides encrypted-at-rest storage with owner isolation and tamper detection.
 * Uses AES-GCM 256 for authenticated encryption and PBKDF2 for key derivation.
 */

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

// Constants for security parameters
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTE_LENGTH = 16;
const IV_BYTE_LENGTH = 12;
const KEY_ALGO = "AES-GCM";
const KEY_LENGTH = 256;
const SECRET_PREFIX = "secret";
const SALT_KEY = "__salt";

/**
 * Helper to convert Uint8Array to Base64 string without using external dependencies
 * or crashing on large arrays.
 */
function bufToB64(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.byteLength; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

/**
 * Helper to convert Base64 string to Uint8Array.
 */
function b64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 1. Handle Salt: Retrieve existing salt or generate a new one.
  let saltBytes: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);
  if (storedSalt) {
    saltBytes = b64ToBuf(storedSalt);
  } else {
    saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
    await storage.set(SALT_KEY, bufToB64(saltBytes));
  }

  // 2. Derive the Master Key using PBKDF2
  // We import the password as a raw key first
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  // Derive the AES-GCM key
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: KEY_ALGO, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * Helper to generate the storage key for a specific owner and secret name.
   * We encode owner and name to avoid collision and delimiter issues.
   */
  const buildStorageKey = (owner: string, name: string): string => {
    const ownerB64 = bufToB64(encoder.encode(owner));
    const nameB64 = bufToB64(encoder.encode(name));
    return `${SECRET_PREFIX}:${ownerB64}:${nameB64}`;
  };

  /**
   * Associated Data (AD) binds the secret to its owner and name.
   * This prevents "copy-paste" attacks where an attacker moves an encrypted
   * blob from one key to another.
   */
  const buildAD = (owner: string, name: string): Uint8Array => {
    return encoder.encode(`${owner}\0${name}`);
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
      const ad = buildAD(owner, name);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: KEY_ALGO, iv, additionalData: ad },
        encryptionKey,
        plaintext,
      );

      // Store IV + Ciphertext together as a single base64 string
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(buildStorageKey(owner, name), bufToB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = buildStorageKey(owner, name);
      const encryptedB64 = await storage.get(key);
      if (!encryptedB64) return undefined;

      try {
        const combined = b64ToBuf(encryptedB64);
        if (combined.length < IV_BYTE_LENGTH) throw new Error("Invalid data");

        const iv = combined.slice(0, IV_BYTE_LENGTH);
        const ciphertext = combined.slice(IV_BYTE_LENGTH);
        const ad = buildAD(owner, name);

        const decrypted = await crypto.subtle.decrypt(
          { name: KEY_ALGO, iv, additionalData: ad },
          encryptionKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Decryption failure (wrong key or tampered data) must throw an Error
        throw new Error("Failed to decrypt secret: data may be tampered with or incorrect password.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = bufToB64(encoder.encode(owner));
      const prefix = `${SECRET_PREFIX}:${ownerB64}:`;

      const ownerSecretsB64 = allKeys.filter((k) => k.startsWith(prefix));
      const names: string[] = [];

      for (const k of ownerSecretsB64) {
        const parts = k.split(":");
        // parts[0] = prefix, parts[1] = owner, parts[2] = name
        if (parts.length === 3) {
          names.push(decoder.decode(b64ToBuf(parts[2])));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = buildStorageKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;

      await storage.delete(key);
      return true;
    },
  };
}
