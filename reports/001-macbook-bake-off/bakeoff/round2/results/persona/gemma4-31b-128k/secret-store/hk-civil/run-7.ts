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
 * Helper to convert strings to Base64 for safe storage keys, 
 * ensuring UTF-8 characters are handled correctly.
 */
function toB64(str: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

/**
 * Helper to convert Base64 strings back to UTF-8.
 */
function fromB64(str: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));
}

/**
 * Helper to convert a Uint8Array to a Base64 string.
 */
function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Helper to convert a Base64 string to a Uint8Array.
 */
function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  // 1. Handle Salt for Key Derivation
  const SALT_KEY = "__salt__";
  let saltB64 = await storage.get(SALT_KEY);

  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }

  const salt = b64ToBytes(saltB64);

  // 2. Derive the Master Key using PBKDF2
  // We use a high iteration count to protect against brute-force attacks on the master password.
  const baseKey = await crypto.subtle.importKey(
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
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const valueBytes = encoder.encode(value);
      
      // Use AAD (Additional Authenticated Data) to bind the ciphertext to the owner and name.
      // This prevents "cut-and-paste" attacks where an attacker moves one encrypted 
      // secret to another key.
      const aad = encoder.encode(`${owner}\0${name}`);

      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        cryptoKey,
        valueBytes,
      );

      const encryptedBytes = new Uint8Array(encrypted);
      const combined = new Uint8Array(iv.length + encryptedBytes.length);
      combined.set(iv);
      combined.set(encryptedBytes, iv.length);

      const storageKey = `s:${toB64(owner)}:${toB64(name)}`;
      await storage.set(storageKey, bytesToB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `s:${toB64(owner)}:${toB64(name)}`;
      const blobB64 = await storage.get(storageKey);
      if (blobB64 === undefined) return undefined;

      const combined = b64ToBytes(blobB64);
      if (combined.length < 13) {
        throw new Error("Stored data is corrupted");
      }

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = encoder.encode(`${owner}\0${name}`);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          cryptoKey,
          ciphertext,
        );
        return new TextDecoder().decode(decrypted);
      } catch (e) {
        // AES-GCM throws an OperationError if the authentication tag is invalid
        // (e.g., due to tampering or wrong master password).
        throw new Error("Secret decryption failed: Tampering detected or invalid password");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `s:${toB64(owner)}:`;
      
      const secretNames: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const nameB64 = key.slice(ownerPrefix.length);
          secretNames.push(fromB64(nameB64));
        }
      }

      return secretNames.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `s:${toB64(owner)}:${toB64(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}

