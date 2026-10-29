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
const ITERATIONS = 100000;
const IV_LENGTH = 12;
const ALGO_NAME = "AES-GCM";

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  // 1. Handle Master Salt
  let saltStr = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (saltStr === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bufferToBase64(salt));
  } else {
    salt = base64ToBuffer(saltStr);
  }

  // 2. Derive Master Key using PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const cryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: ALGO_NAME, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const aad = encoder.encode(`${owner}\x00${name}`);
      const data = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: ALGO_NAME, iv, additionalData: aad },
        cryptoKey,
        data,
      );

      // Store IV + Ciphertext as a single Base64 string
      const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), IV_LENGTH);

      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      await storage.set(storageKey, bufferToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const encryptedB64 = await storage.get(storageKey);

      if (encryptedB64 === undefined) return undefined;

      try {
        const combined = base64ToBuffer(encryptedB64);
        if (combined.length < IV_LENGTH) throw new Error("Invalid data length");

        const iv = combined.slice(0, IV_LENGTH);
        const ciphertext = combined.slice(IV_LENGTH);
        const aad = encoder.encode(`${owner}\x00${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: ALGO_NAME, iv, additionalData: aad },
          cryptoKey,
          ciphertext,
        );

        return new TextDecoder().decode(decrypted);
      } catch (e) {
        // Tampering detected or wrong master password leads to decryption failure
        throw new Error("Secret decryption failed: Data tampered or invalid key");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `secret:${btoa(owner)}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const nameB64 = key.substring(ownerPrefix.length);
          names.push(atob(nameB64));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}

/**
 * Helper to convert Uint8Array to Base64 string
 */
function bufferToBase64(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer));
}

/**
 * Helper to convert Base64 string back to Uint8Array
 */
function base64ToBuffer(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
