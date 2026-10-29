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
 * Utility to handle binary data conversion to/from base64 strings
 * as the KeyValueStorage only supports strings.
 */
const binToB64 = (buf: Uint8Array): string => btoa(String.fromCharCode(...buf));
const b64ToBin = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 1. Master Key Derivation
  // We use a salt stored in the KV storage to derive a high-entropy key from the password.
  const SALT_KEY = "system:master_salt";
  let saltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, binToB64(salt));
  } else {
    salt = b64ToBin(saltB64);
  }

  // Import raw password as a Key object for PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  // Derive a 256-bit AES-GCM key using PBKDF2
  const masterKey = await crypto.subtle.deriveKey(
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
   * Generates a storage key. 
   * We encode owner and name to base64 to ensure characters like ':' don't break the structure.
   */
  const getStorageKey = (owner: string, name: string): string => {
    const oB64 = binToB64(encoder.encode(owner));
    const nB64 = binToB64(encoder.encode(name));
    return `secret:v1:${oB64}:${nB64}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      // AAD (Additional Authenticated Data) ensures isolation and detects tampering.
      // By binding the owner and name to the ciphertext, an attacker cannot swap 
      // one secret's data for another.
      const aad = encoder.encode(`${owner}\0${name}`);
      const plainText = encoder.encode(value);

      const cipherBuffer = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: aad,
        },
        masterKey,
        plainText,
      );

      const cipherText = new Uint8Array(cipherBuffer);
      
      // Store IV + Ciphertext together. 
      // IV is public, but the ciphertext (including GCM tag) is encrypted and authenticated.
      const storageValue = new Uint8Array(iv.length + cipherText.length);
      storageValue.set(iv);
      storageValue.set(cipherText, iv.length);

      await storage.set(getStorageKey(owner, name), binToB64(storageValue));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const dataB64 = await storage.get(getStorageKey(owner, name));
      if (dataB64 === undefined) return undefined;

      const combined = b64ToBin(dataB64);
      if (combined.length < 12) {
        throw new Error("Stored secret is corrupted or too short.");
      }

      const iv = combined.slice(0, 12);
      const cipherText = combined.slice(12);
      const aad = encoder.encode(`${owner}\0${name}`);

      try {
        const decryptedBuffer = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
          },
          masterKey,
          cipherText,
        );
        return decoder.decode(decryptedBuffer);
      } catch (e) {
        // AES-GCM throws an OperationError if the authentication tag is invalid.
        // This happens if the data was tampered with, the password is wrong, 
        // or the ciphertext was moved from another owner/name.
        throw new Error("Secret decryption failed: data tampering detected or invalid master password.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = binToB64(encoder.encode(owner));
      const prefix = `secret:v1:${ownerB64}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          const nameB64 = parts[parts.length - 1];
          names.push(decoder.decode(b64ToBin(nameB64)));
        }
      }
      return names.sort();
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
