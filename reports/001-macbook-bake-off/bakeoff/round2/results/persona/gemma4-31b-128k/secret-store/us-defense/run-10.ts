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
 * Production-grade Secret Store implementation.
 * 
 * Security Architecture:
 * 1. Key Derivation: Uses PBKDF2 with 600k iterations and a stored random salt to derive 
 *    a 256-bit AES key from the master password.
 * 2. Encryption: Uses AES-GCM (Galois/Counter Mode) for Authenticated Encryption with 
 *    Associated Data (AEAD).
 * 3. Tamper Resistance: The Owner ID and Secret Name are passed as "Additional Authenticated Data" 
 *    (AAD). This binds the encrypted blob to the specific key path, preventing "swap attacks" 
 *    where an attacker copies one valid encrypted blob over another.
 * 4. Isolation: Keys are namespaced using Base64 encoded identifiers to handle arbitrary characters.
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  const SALT_KEY = "__system_master_salt__";
  const PREFIX = "secret:v1:";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // --- Helper: Binary <-> Base64 ---
  const bytesToBase64 = (bytes: Uint8Array): string => {
    return btoa(String.fromCharCode(...bytes));
  };

  const base64ToBytes = (base64: string): Uint8Array => {
    const bin = atob(base64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  // --- Key Derivation ---
  let saltBytes = await storage.get(SALT_KEY);
  if (saltBytes === undefined) {
    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    saltBytes = bytesToBase64(newSalt);
    await storage.set(SALT_KEY, saltBytes);
  }

  const salt = base64ToBytes(saltBytes);
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
      iterations: 600000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- Storage Key Generation ---
  const getStorageKey = (owner: string, name: string): string => {
    // Use btoa to ensure keys are safe and non-colliding regardless of input characters
    return `${PREFIX}${btoa(owner)}:${btoa(name)}`;
  };

  // --- Associated Data ---
  // Binding the owner and name to the ciphertext prevents copying a blob 
  // from one user/secret to another.
  const getAAD = (owner: string, name: string): Uint8Array => {
    return encoder.encode(`${owner}\0${name}`);
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = getAAD(owner, name);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
        },
        cryptoKey,
        plaintext,
      );

      // Store as [IV(12 bytes)][Ciphertext]
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const stored = await storage.get(getStorageKey(owner, name));
      if (stored === undefined) return undefined;

      try {
        const combined = base64ToBytes(stored);
        if (combined.length < 13) throw new Error("Invalid data length");

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = getAAD(owner, name);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad,
          },
          cryptoKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Any decryption failure (wrong password, tampered data, or swap attack)
        // must result in an Error being thrown as per requirements.
        throw new Error("Failed to retrieve secret: data is tampered or key is invalid");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `${PREFIX}${btoa(owner)}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const b64Name = key.slice(ownerPrefix.length);
          names.push(atob(b64Name));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const existed = await storage.get(key) !== undefined;
      await storage.delete(key);
      return existed;
    },
  };
}
