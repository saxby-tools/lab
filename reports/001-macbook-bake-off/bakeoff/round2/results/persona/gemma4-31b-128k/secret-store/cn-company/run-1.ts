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
 * Helper functions for Base64 encoding/decoding of Uint8Arrays
 * since we cannot import external libraries.
 */
function bufToBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function base64ToBuf(str: string): Uint8Array {
  const binary = atob(str);
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

  const SALT_KEY = "__master_salt__";
  const PBKDF2_ITERATIONS = 100000;

  // 1. Handle Salt for Key Derivation
  let saltStr = await storage.get(SALT_KEY);
  let saltBytes: Uint8Array;

  if (saltStr === undefined) {
    saltBytes = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bufToBase64(saltBytes));
  } else {
    saltBytes = base64ToBuf(saltStr);
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

  // Derive an AES-GCM key from the PBKDF2 process
  const masterKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * Generates a unique storage key for a specific owner and secret name.
   * We base64 encode the components to ensure no collision regardless of input characters.
   */
  const getStorageKey = (owner: string, name: string): string => {
    return `secret:${bufToBase64(encoder.encode(owner))}:${bufToBase64(encoder.encode(name))}`;
  };

  /**
   * Additional Authenticated Data (AAD) binds the ciphertext to the 
   * specific owner and name, preventing "copy-paste" attacks where an
   * attacker moves a secret from one slot to another.
   */
  const getAAD = (owner: string, name: string): Uint8Array => {
    return encoder.encode(`${owner}\0${name}`);
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = getStorageKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = getAAD(owner, name);
      const plaintext = encoder.encode(value);

      const ciphertextBuffer = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
        },
        masterKey,
        plaintext,
      );

      const ciphertext = new Uint8Array(ciphertextBuffer);
      
      // Store as [IV (12 bytes)][Ciphertext + Tag]
      const combined = new Uint8Array(iv.length + ciphertext.length);
      combined.set(iv, 0);
      combined.set(ciphertext, iv.length);

      await storage.set(key, bufToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = getStorageKey(owner, name);
      const storedB64 = await storage.get(key);

      if (storedB64 === undefined) {
        return undefined;
      }

      try {
        const combined = base64ToBuf(storedB64);
        if (combined.length < 12) {
          throw new Error("Stored data corrupted");
        }

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = getAAD(owner, name);

        const decryptedBuffer = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad,
          },
          masterKey,
          ciphertext,
        );

        return decoder.decode(decryptedBuffer);
      } catch (e) {
        // Any decryption failure (wrong password, modified ciphertext, or swapped slots)
        // results in a generic Error as per requirements.
        throw new Error("Secret decryption failed or data was tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = bufToBase64(encoder.encode(owner));
      const prefix = `secret:${ownerB64}:`;

      const secretNames: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          // The third part is the b64 encoded name
          const nameBytes = base64ToBuf(parts[2]);
          secretNames.push(decoder.decode(nameBytes));
        }
      }

      return secretNames.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key);
      
      if (exists === undefined) {
        return false;
      }

      await storage.delete(key);
      return true;
    },
  };
}
