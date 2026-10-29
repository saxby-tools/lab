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

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  const SALT_KEY = "__system_salt__";
  const SECRET_PREFIX = "s:";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /**
   * Helper to handle Base64 encoding for binary data and UTF-8 strings.
   */
  const toB64 = (data: Uint8Array | string): string => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    return btoa(String.fromCharCode(...bytes));
  };

  const fromB64 = (b64: string): Uint8Array => {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };

  /**
   * Derives a cryptographic key from the master password and a salt.
   */
  const deriveKey = async (salt: Uint8Array): Promise<CryptoKey> => {
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
        iterations: 100000,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  };

  // 1. Handle the salt for PBKDF2.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const masterKey = await deriveKey(fromB64(saltB64));

  /**
   * Constructs a unique storage key for a specific secret.
   * Owners and names are Base64 encoded to ensure the delimiter ':' 
   * does not collide with arbitrary characters in inputs.
   */
  const getStorageKey = (owner: string, name: string) => {
    return `${SECRET_PREFIX}${toB64(owner)}:${toB64(name)}`;
  };

  /**
   * Creates Additional Authenticated Data (AAD) to bind the ciphertext
   * to the specific owner and name, preventing "copy-paste" attacks
   * where a valid ciphertext for one secret is moved to another key.
   */
  const getAAD = (owner: string, name: string) => {
    return encoder.encode(`binding:${owner}:${name}`);
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(value);
      const aad = getAAD(owner, name);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        masterKey,
        plaintext,
      );

      // Combine IV and Ciphertext (which includes the GCM tag) into one blob
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const blobB64 = await storage.get(getStorageKey(owner, name));
      if (blobB64 === undefined) return undefined;

      try {
        const combined = fromB64(blobB64);
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);
        const aad = getAAD(owner, name);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          masterKey,
          data,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // GCM decryption fails if the data was tampered with or the master password is wrong
        throw new Error("Secret decryption failed: data tampering detected or invalid key.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `${SECRET_PREFIX}${toB64(owner)}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const b64Name = key.slice(ownerPrefix.length);
          names.push(decoder.decode(fromB64(b64Name)));
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
