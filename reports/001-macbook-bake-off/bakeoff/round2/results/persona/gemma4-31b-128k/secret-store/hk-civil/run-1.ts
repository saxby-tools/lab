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
 * Implementation of a secure secret store.
 * Uses PBKDF2 for key derivation and AES-GCM for authenticated encryption.
 * To prevent "ciphertext swapping" (where an attacker moves one encrypted secret 
 * to another slot), the owner and name are passed as Additional Authenticated Data (AAD).
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Constants for crypto
  const SALT_KEY = "__secret_store_salt__";
  const PBKDF2_ITERATIONS = 100000;
  const AES_GCM_IV_LENGTH = 12;

  // Helper: Convert Uint8Array to Base64 string for storage
  const binToBase64 = (buf: Uint8Array): string => btoa(String.fromCharCode(...buf));
  // Helper: Convert Base64 string back to Uint8Array
  const base64ToBin = (str: string): Uint8Array => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  // Derive the master key from the password
  let salt: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);
  if (storedSalt) {
    salt = base64ToBin(storedSalt);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, binToBase64(salt));
  }

  const keyMaterial = await crypto.subtle.importKey(
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
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Helper to create a unique, safe storage key for a secret
  const getStorageKey = (owner: string, name: string): string => {
    // We base64 encode components to ensure delimiters don't clash with user input
    const identity = `${owner}:${name}`;
    return `secret:${binToBase64(encoder.encode(identity))}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
      const plaintext = encoder.encode(value);
      
      // Use owner and name as AAD (Additional Authenticated Data)
      // This ensures that a secret stored for Owner A cannot be moved to Owner B's slot
      const aad = encoder.encode(`${owner}:${name}`);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
        },
        cryptoKey,
        plaintext,
      );

      // Store IV + Ciphertext as a single base64 string
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), binToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storedValue = await storage.get(getStorageKey(owner, name));
      if (!storedValue) return undefined;

      try {
        const combined = base64ToBin(storedValue);
        if (combined.length < AES_GCM_IV_LENGTH) {
          throw new Error("Invalid stored data");
        }

        const iv = combined.slice(0, AES_GCM_IV_LENGTH);
        const data = combined.slice(AES_GCM_IV_LENGTH);
        const aad = encoder.encode(`${owner}:${name}`);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad,
          },
          cryptoKey,
          data,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Any failure in decryption (including tag mismatch/tampering) throws an Error
        throw new Error("Secret retrieval failed: integrity check failure or incorrect password");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `secret:`; 
      
      // We must identify keys belonging to the owner. Since we encoded the identity
      // as `owner:name`, we check for keys that decode to start with the owner string.
      const ownerSecrets: string[] = [];
      
      for (const key of allKeys) {
        if (!key.startsWith(ownerPrefix)) continue;
        
        const encodedIdentity = key.slice(ownerPrefix.length);
        const identity = decoder.decode(base64ToBin(encodedIdentity));
        
        // Ensure the identity matches the owner exactly before the first delimiter
        const [storedOwner, ...nameParts] = identity.split(":");
        const name = nameParts.join(":"); // Rejoin in case name contained ':'
        
        if (storedOwner === owner && name !== "") {
          ownerSecrets.push(name);
        }
      }

      return ownerSecrets.sort();
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
