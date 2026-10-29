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
   * Helper to convert Uint8Array to Base64 string
   */
  const toB64 = (bytes: Uint8Array): string => {
    return btoa(String.fromCharCode(...bytes));
  };

  /**
   * Helper to convert Base64 string to Uint8Array
   */
  const fromB64 = (b64: string): Uint8Array => {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };

  /**
   * Helper to derive the encryption key from the master password.
   * We use PBKDF2 to derive a strong key and store the salt in the KV storage.
   */
  let saltB64 = await storage.get("__salt__");
  let salt: Uint8Array;

  if (saltB64) {
    salt = fromB64(saltB64);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set("__salt__", toB64(salt));
  }

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
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * To prevent "copy-paste" attacks where an attacker moves a ciphertext
   * from one slot to another, we use the owner and name as Additional
   * Authenticated Data (AAD).
   */
  const getAAD = (owner: string, name: string): Uint8Array => {
    return encoder.encode(`${owner}\0${name}`);
  };

  /**
   * We encode the owner and name in the storage key to support arbitrary characters
   * and allow efficient filtering for the `list` operation.
   */
  const getStorageKey = (owner: string, name: string): string => {
    const ownerB64 = toB64(encoder.encode(owner));
    const nameB64 = toB64(encoder.encode(name));
    return `s:${ownerB64}:${nameB64}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = getAAD(owner, name);
      const data = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        encryptionKey,
        data,
      );

      // Store IV and ciphertext together
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storedB64 = await storage.get(getStorageKey(owner, name));
      if (storedB64 === undefined) return undefined;

      try {
        const combined = fromB64(storedB64);
        if (combined.length < 12) throw new Error("Invalid data");

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = getAAD(owner, name);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          encryptionKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Any decryption failure (authentication tag mismatch) is treated as tampering
        throw new Error("Secret tampering detected or incorrect master password");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = toB64(encoder.encode(owner));
      const prefix = `s:${ownerB64}:`;

      const names = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => {
          const nameB64 = k.substring(prefix.length);
          return decoder.decode(fromB64(nameB64));
        });

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key) !== undefined;
      if (exists) {
        await storage.delete(key);
        return true;
      }
      return false;
    },
  };
}
