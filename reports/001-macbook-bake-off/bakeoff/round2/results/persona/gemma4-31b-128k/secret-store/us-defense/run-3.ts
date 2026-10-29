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
 * Helper functions for binary data <-> base64 string conversion
 * since external imports are forbidden.
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
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
  const SALT_KEY = "__system_salt__";
  const encoder = new TextEncoder();

  // 1. Handle Master Key derivation
  let salt: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);

  if (storedSalt) {
    salt = fromBase64(storedSalt);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, toBase64(salt));
  }

  // Derive a 256-bit AES-GCM key using PBKDF2
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

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(value);
      
      // Use Owner and Name as Additional Authenticated Data (AAD)
      // The null byte prevents boundary attacks (e.g., "A"+"BC" vs "AB"+"C")
      const aad = encoder.encode(`${owner}\0${name}`);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv, additionalData: aad },
        aesKey,
        plaintext,
      );

      // Store IV + Ciphertext. 
      // Storage key is base64 encoded to handle arbitrary characters in owner/name.
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(storageKey, toBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const storedValue = await storage.get(storageKey);

      if (storedValue === undefined) {
        return undefined;
      }

      const combined = fromBase64(storedValue);
      if (combined.length < 28) { // 12 bytes IV + 16 bytes GCM Tag
        throw new Error("Tampering detected: Invalid data length");
      }

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = encoder.encode(`${owner}\0${name}`);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: iv, additionalData: aad },
          aesKey,
          ciphertext,
        );
        return new TextDecoder().decode(decrypted);
      } catch (e) {
        // AES-GCM throws if the authentication tag is invalid
        throw new Error("Tampering detected: Data integrity check failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `secret:${btoa(owner)}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          if (parts.length === 3) {
            names.push(atob(parts[2]));
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) {
        return false;
      }
      await storage.delete(storageKey);
      return true;
    },
  };
}
