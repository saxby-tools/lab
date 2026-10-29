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

  const SALT_KEY = "__system_salt__";
  const SEC_PREFIX = "sec:";

  /**
   * Utility to convert Uint8Array to Base64 string
   */
  const binToB64 = (bin: Uint8Array): string => {
    return btoa(String.fromCharCode(...bin));
  };

  /**
   * Utility to convert Base64 string to Uint8Array
   */
  const b64ToBin = (b64: string): Uint8Array => {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };

  /**
   * Encode a string to Base64 (handling UTF-8)
   */
  const encodeStr = (str: string): string => binToB64(encoder.encode(str));

  /**
   * Decode a Base64 string back to UTF-8
   */
  const decodeStr = (b64: string): string => decoder.decode(b64ToBin(b64));

  // 1. Handle Salt for Key Derivation
  let saltB64 = await storage.get(SALT_KEY);
  if (!saltB64) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = binToB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = b64ToBin(saltB64);

  // 2. Derive the Master Key using PBKDF2
  const passwordKeyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const masterKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(owner + "\0" + name);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: aad,
        },
        masterKey,
        plaintext,
      );

      // Combine IV and Ciphertext into one blob
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      const storageKey = `${SEC_PREFIX}${encodeStr(owner)}:${encodeStr(name)}`;
      await storage.set(storageKey, binToB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `${SEC_PREFIX}${encodeStr(owner)}:${encodeStr(name)}`;
      const encryptedB64 = await storage.get(storageKey);

      if (encryptedB64 === undefined) {
        return undefined;
      }

      const combined = b64ToBin(encryptedB64);
      if (combined.length < 12) {
        throw new Error("Stored secret data is corrupted or too short");
      }

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = encoder.encode(owner + "\0" + name);

      try {
        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
          },
          masterKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws an OperationError if authentication fails (tampering)
        throw new Error("Secret decryption failed: Data may have been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = `${SEC_PREFIX}${encodeStr(owner)}:`;
      const allKeys = await storage.keys();

      const names = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => {
          const encodedName = k.slice(prefix.length);
          return decodeStr(encodedName);
        });

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `${SEC_PREFIX}${encodeStr(owner)}:${encodeStr(name)}`;
      const exists = await storage.get(storageKey) !== undefined;

      if (exists) {
        await storage.delete(storageKey);
      }

      return exists;
    },
  };
}

