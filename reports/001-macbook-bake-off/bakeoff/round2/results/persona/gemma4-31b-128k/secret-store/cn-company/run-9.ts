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
 * Implementation of a SecretStore that ensures confidentiality, 
 * owner isolation, and tamper detection using AES-GCM and PBKDF2.
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Configuration for Key Derivation
  const SALT_KEY = "__system_salt__";
  const PBKDF2_ITERATIONS = 100000;
  const AES_GCM_IV_LENGTH = 12;

  /**
   * Utility: Convert Uint8Array to Base64 string for storage
   */
  const bufToBase64 = (buf: Uint8Array): string => {
    return btoa(String.fromCharCode(...buf));
  };

  /**
   * Utility: Convert Base64 string to Uint8Array
   */
  const base64ToBuf = (str: string): Uint8Array => {
    const bin = atob(str);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  /**
   * Derive the master encryption key from the password and a persistent salt.
   */
  const deriveMasterKey = async (): Promise<CryptoKey> => {
    let saltBase64 = await storage.get(SALT_KEY);
    let salt: Uint8Array;

    if (saltBase64) {
      salt = base64ToBuf(saltBase64);
    } else {
      // Generate and persist salt if it doesn't exist
      salt = crypto.getRandomValues(new Uint8Array(16));
      await storage.set(SALT_KEY, bufToBase64(salt));
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
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  };

  const masterKey = await deriveMasterKey();

  /**
   * Generate a unique storage key for a specific secret.
   * Owner and Name are Base64 encoded to avoid delimiter collisions.
   */
  const getStorageKey = (owner: string, name: string): string => {
    return `secret:${bufToBase64(encoder.encode(owner))}:${bufToBase64(encoder.encode(name))}`;
  };

  /**
   * Generate Associated Authenticated Data (AAD) to bind the ciphertext
   * to a specific owner and secret name, preventing "copy-paste" attacks.
   */
  const getAAD = (owner: string, name: string): Uint8Array => {
    return encoder.encode(`${owner}\0${name}`);
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
      const aad = getAAD(owner, name);
      const data = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
        },
        masterKey,
        data,
      );

      // Store IV + Ciphertext (which includes the GCM auth tag)
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), bufToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const encryptedBase64 = await storage.get(getStorageKey(owner, name));
      if (encryptedBase64 === undefined) return undefined;

      const combined = base64ToBuf(encryptedBase64);
      if (combined.length < AES_GCM_IV_LENGTH) {
        throw new Error("Stored data is corrupted");
      }

      const iv = combined.slice(0, AES_GCM_IV_LENGTH);
      const ciphertext = combined.slice(AES_GCM_IV_LENGTH);
      const aad = getAAD(owner, name);

      try {
        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad,
          },
          masterKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws if authentication fails (tampering or wrong key)
        throw new Error("Secret decryption failed: Data may be tampered with or master password incorrect");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = bufToBase64(encoder.encode(owner));
      const prefix = `secret:${ownerB64}:`;

      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          if (parts.length === 3) {
            const nameB64 = parts[2];
            names.push(decoder.decode(base64ToBuf(nameB64)));
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key);
      if (exists === undefined) return false;

      await storage.delete(key);
      return true;
    },
  };
}
