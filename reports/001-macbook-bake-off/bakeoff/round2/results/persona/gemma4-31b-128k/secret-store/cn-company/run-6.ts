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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /**
   * Helper to convert strings to Base64 and vice versa safely for any UTF-8 character.
   */
  const toB64 = (str: string) => btoa(String.fromCharCode(...encoder.encode(str)));
  const fromB64 = (b64: string) => decoder.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const bytesToB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // 1. Handle Master Key Derivation
  let saltB64 = await storage.get("__store_salt__");
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToB64(salt);
    await storage.set("__store_salt__", saltB64);
  }
  const salt = b64ToBytes(saltB64);

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
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * Constructs a unique storage key based on owner and name.
   * Using Base64 encoding to ensure characters like ':' don't cause collisions.
   */
  const getStorageKey = (owner: string, name: string) => `s:${toB64(owner)}:${toB64(name)}`;

  /**
   * Constructs Additional Authenticated Data (AAD) to bind the ciphertext 
   * to the specific owner and secret name, preventing "copy-paste" attacks.
   */
  const getAAD = (owner: string, name: string) => encoder.encode(JSON.stringify([owner, name]));

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = getAAD(owner, name);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        cryptoKey,
        plaintext,
      );

      // Store IV + Ciphertext (combined into a single byte array)
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), bytesToB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const dataB64 = await storage.get(getStorageKey(owner, name));
      if (dataB64 === undefined) return undefined;

      try {
        const combined = b64ToBytes(dataB64);
        if (combined.length < 12) throw new Error("Invalid data");

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = getAAD(owner, name);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          cryptoKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // If decryption fails (due to wrong password or tampering), throw Error
        throw new Error("Secret retrieval failed: integrity check failure or incorrect master password");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `s:${toB64(owner)}:`;
      
      const names = allKeys
        .filter((k) => k.startsWith(ownerPrefix))
        .map((k) => {
          const nameB64 = k.slice(ownerPrefix.length);
          return fromB64(nameB64);
        });

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
