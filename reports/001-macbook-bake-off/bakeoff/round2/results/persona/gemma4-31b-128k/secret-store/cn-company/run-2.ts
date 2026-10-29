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

/**
 * Utility to handle binary data <-> base64 string conversion
 * avoiding stack overflow on large arrays.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // 1. Handle Salt for PBKDF2
  const SALT_KEY = "__store_salt__";
  const storedSaltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (storedSaltB64) {
    salt = fromBase64(storedSaltB64);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, toBase64(salt));
  }

  // 2. Derive the Master Key using PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * Helper to generate a unique storage key for a secret.
   * We base64 encode owner and name to ensure they don't interfere
   * with the storage key delimiter.
   */
  const getSecretStorageKey = (owner: string, name: string): string => {
    const oB64 = toBase64(encoder.encode(owner));
    const nB64 = toBase64(encoder.encode(name));
    return `secret:${oB64}:${nB64}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // We use the owner and name as Additional Authenticated Data (AAD).
      // This prevents an attacker from moving a ciphertext from one secret 
      // to another (even for the same owner) or between owners.
      const aad = encoder.encode(owner + "\0" + name);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: aad,
        },
        aesKey,
        plaintext,
      );

      // Combine IV and Ciphertext into one blob for storage
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      const key = getSecretStorageKey(owner, name);
      await storage.set(key, toBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = getSecretStorageKey(owner, name);
      const storedB64 = await storage.get(key);
      if (storedB64 === undefined) return undefined;

      try {
        const combined = fromBase64(storedB64);
        if (combined.length < 12) throw new Error("Invalid data length");

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = encoder.encode(owner + "\0" + name);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
          },
          aesKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Any decryption failure (wrong key, modified data, shifted ciphertext)
        // must result in an Error to detect tampering.
        throw new Error("Secret decryption failed: Data may be corrupted or tampered with.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const ownerB64 = toBase64(encoder.encode(owner));
      const prefix = `secret:${ownerB64}:`;
      const allKeys = await storage.keys();

      const secretNames: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const parts = k.split(":");
          const nameB64 = parts[2];
          secretNames.push(decoder.decode(fromBase64(nameB64)));
        }
      }

      return secretNames.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getSecretStorageKey(owner, name);
      const exists = await storage.get(key);
      if (exists === undefined) return false;

      await storage.delete(key);
      return true;
    },
  };
}
