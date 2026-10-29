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
 * Helper to convert binary data to Base64 and vice versa.
 * Using global btoa/atob available in Deno/Web environment.
 */
const binToBase64 = (buf: Uint8Array): string => 
  btoa(String.fromCharCode(...buf));

const base64ToBin = (str: string): Uint8Array => 
  Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Configuration for Key Derivation
  const SALT_KEY = "__store_salt";
  const PBKDF2_ITERATIONS = 100_000;
  const AES_ALGO = "AES-GCM";

  /**
   * Derives a cryptographic key from the master password and a salt.
   */
  async function deriveMasterKey(): Promise<CryptoKey> {
    let saltBase64 = await storage.get(SALT_KEY);
    let salt: Uint8Array;

    if (saltBase64) {
      salt = base64ToBin(saltBase64);
    } else {
      // Initialize salt for a new storage
      salt = crypto.getRandomValues(new Uint8Array(16));
      await storage.set(SALT_KEY, binToBase64(salt));
    }

    const passwordKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(masterPassword),
      "PBKDF2",
      false,
      ["deriveKey"],
    );

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      passwordKey,
      { name: AES_ALGO, length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  const masterKey = await deriveMasterKey();

  /**
   * Storage keys are constructed using Base64 to avoid collision with
   * delimiters, as owner/name can contain any characters.
   */
  function getStorageKey(owner: string, name: string): string {
    return `secret:${binToBase64(encoder.encode(owner))}:${binToBase64(encoder.encode(name))}`;
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(value);
      
      // Use owner and name as Additional Authenticated Data (AAD) to prevent 
      // "copy-paste" attacks where one secret is moved to another owner/name.
      const aad = encoder.encode(owner + name);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: AES_ALGO,
          iv: iv,
          additionalData: aad,
        },
        masterKey,
        plaintext,
      );

      // Payload format: IV (12 bytes) || Ciphertext (includes tag)
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), binToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const dataBase64 = await storage.get(getStorageKey(owner, name));
      if (!dataBase64) return undefined;

      const combined = base64ToBin(dataBase64);
      if (combined.length < 12) {
        throw new Error("Stored data is corrupted");
      }

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = encoder.encode(owner + name);

      try {
        const decrypted = await crypto.subtle.decrypt(
          {
            name: AES_ALGO,
            iv: iv,
            additionalData: aad,
          },
          masterKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // This triggers if the master password is wrong or data was tampered with.
        throw new Error("Decryption failed: data tampered with or invalid key");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = binToBase64(encoder.encode(owner));
      const prefix = `secret:${ownerB64}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const nameB64 = key.slice(prefix.length);
          const name = decoder.decode(base64ToBin(nameB64));
          names.push(name);
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
