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
 * Helper to convert Uint8Array to Base64 string safely for large buffers
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Helper to convert Base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 1. Handle Salt for Key Derivation
  const SALT_KEY = "__system_salt__";
  let saltBase64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (saltBase64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, uint8ArrayToBase64(salt));
  } else {
    salt = base64ToUint8Array(saltBase64);
  }

  // 2. Derive the Master Key using PBKDF2
  // We derive a 256-bit key for AES-GCM
  const passwordBytes = encoder.encode(masterPassword);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const cryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Implementation of the SecretStore interface
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const valueBytes = encoder.encode(value);
      
      // Use owner and name as Additional Authenticated Data (AAD)
      // This binds the ciphertext to this specific owner and secret name,
      // preventing an attacker from swapping ciphertexts between secrets.
      const aad = encoder.encode(owner + "\0" + name);

      const ciphertextBuffer = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: aad,
        },
        cryptoKey,
        valueBytes,
      );

      const ciphertext = new Uint8Array(ciphertextBuffer);
      
      // Combine IV and Ciphertext for storage
      const combined = new Uint8Array(iv.length + ciphertext.length);
      combined.set(iv, 0);
      combined.set(ciphertext, iv.length);

      // Storage key format: secrets:<b64-owner>:<b64-name>
      const storageKey = `secrets:${btoa(owner)}:${btoa(name)}`;
      await storage.set(storageKey, uint8ArrayToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secrets:${btoa(owner)}:${btoa(name)}`;
      const storedValue = await storage.get(storageKey);

      if (storedValue === undefined) {
        return undefined;
      }

      try {
        const combined = base64ToUint8Array(storedValue);
        if (combined.length < 13) throw new Error("Malformed data");

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = encoder.encode(owner + "\0" + name);

        const decryptedBuffer = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
          },
          cryptoKey,
          ciphertext,
        );

        return decoder.decode(decryptedBuffer);
      } catch (e) {
        // Any decryption failure (wrong password, corrupted data, swapped data) 
        // must result in a thrown Error.
        throw new Error("Secret decryption failed: data may be corrupted or tampered with.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `secrets:${btoa(owner)}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const parts = key.split(":");
          // The name is the 3rd part of the storage key
          if (parts.length === 3) {
            names.push(atob(parts[2]));
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secrets:${btoa(owner)}:${btoa(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) {
        return false;
      }
      await storage.delete(storageKey);
      return true;
    },
  };
}
