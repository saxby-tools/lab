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
 * Implementation of a secure Secret Store.
 * 
 * Security Design:
 * 1. Key Derivation: PBKDF2 is used to derive a master key from the password and a persistent salt.
 * 2. Encryption: AES-GCM (Authenticated Encryption with Associated Data) provides confidentiality and integrity.
 * 3. Swap Attack Protection: The owner and secret name are passed as Additional Authenticated Data (AAD).
 *    This ensures that ciphertext cannot be moved from one storage key to another without detection.
 * 4. Isolation: Keys are namespaced by owner and name.
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // --- Constants ---
  const SALT_KEY = "__system_master_salt__";
  const PBKDF2_ITERATIONS = 100000;
  const AES_GCM_IV_LENGTH = 12;
  const SALT_LENGTH = 16;

  // --- Helpers ---
  const toBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const fromBase64 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  const getStorageKey = (owner: string, name: string): string => {
    // Use base64 to prevent collisions with delimiters
    return `s:${toBase64(encoder.encode(owner))}:${toBase64(encoder.encode(name))}`;
  };

  // --- Key Management ---
  let masterSalt: Uint8Array;
  const existingSalt = await storage.get(SALT_KEY);
  if (existingSalt) {
    masterSalt = fromBase64(existingSalt);
  } else {
    masterSalt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    await storage.set(SALT_KEY, toBase64(masterSalt));
  }

  // Derive the AES-GCM key from the master password
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: masterSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
      const plaintext = encoder.encode(value);
      
      // AAD binds the ciphertext to the specific owner and secret name
      const aad = encoder.encode(`${owner}\u0000${name}`);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        encryptionKey,
        plaintext,
      );

      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), toBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const encryptedBase64 = await storage.get(getStorageKey(owner, name));
      if (!encryptedBase64) return undefined;

      try {
        const combined = fromBase64(encryptedBase64);
        if (combined.length < AES_GCM_IV_LENGTH) {
          throw new Error("Invalid stored data");
        }

        const iv = combined.slice(0, AES_GCM_IV_LENGTH);
        const ciphertext = combined.slice(AES_GCM_IV_LENGTH);
        const aad = encoder.encode(`${owner}\u0000${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          encryptionKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Any decryption failure (wrong password, tampered data, or swapped keys)
        // must result in an Error.
        throw new Error("Failed to decrypt secret: integrity check failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `s:${toBase64(encoder.encode(owner))}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const parts = key.split(":");
          if (parts.length === 3) {
            const nameBytes = fromBase64(parts[2]);
            names.push(decoder.decode(nameBytes));
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key);
      if (!exists) return false;

      await storage.delete(key);
      return true;
    },
  };
}
