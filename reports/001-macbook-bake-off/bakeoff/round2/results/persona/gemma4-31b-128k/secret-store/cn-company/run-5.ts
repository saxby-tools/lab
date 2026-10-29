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

  // Constants for Security
  const SALT_KEY = "sys:salt";
  const PBKDF2_ITERATIONS = 100000;
  const AES_GCM_IV_LENGTH = 12;
  const SALT_LENGTH = 16;

  /**
   * We use Base64 encoding for keys in the KV store because owner/name can 
   * contain any character, including delimiters.
   */
  const toB64 = (str: string) => btoa(str);
  const fromB64 = (str: string) => atob(str);

  // 1. Key Derivation Logic
  // We need a consistent salt across sessions to derive the same key from the password.
  let salt: Uint8Array;
  const storedSaltB64 = await storage.get(SALT_KEY);

  if (storedSaltB64) {
    salt = Uint8Array.from(atob(storedSaltB64), (c) => c.charCodeAt(0));
  } else {
    salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    await storage.set(SALT_KEY, btoa(String.fromCharCode(...salt)));
  }

  const masterKeyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    masterKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * Helper to create a unique storage key.
   * Format: s:{b64_owner}:{b64_name}
   */
  const getStorageKey = (owner: string, name: string) => `s:${toB64(owner)}:${toB64(name)}`;

  /**
   * Helper to create Additional Authenticated Data (AAD).
   * Including owner and name in AAD prevents "cut-and-paste" attacks where an attacker
   * copies a ciphertext from one secret to another.
   */
  const getAAD = (owner: string, name: string) => encoder.encode(`${owner}\0${name}`);

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
      const encrypted = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: getAAD(owner, name),
        },
        derivedKey,
        encoder.encode(value),
      );

      // Store IV and Ciphertext together
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);

      await storage.set(getStorageKey(owner, name), btoa(String.fromCharCode(...combined)));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storedB64 = await storage.get(getStorageKey(owner, name));
      if (!storedB64) return undefined;

      try {
        const combined = Uint8Array.from(atob(storedB64), (c) => c.charCodeAt(0));
        if (combined.length < AES_GCM_IV_LENGTH) {
          throw new Error("Corrupted data");
        }

        const iv = combined.slice(0, AES_GCM_IV_LENGTH);
        const ciphertext = combined.slice(AES_GCM_IV_LENGTH);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv,
            additionalData: getAAD(owner, name),
          },
          derivedKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws an OperationError if the tag doesn't match (tampering or wrong password)
        throw new Error("Secret decryption failed: Data is corrupted or unauthorized");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `s:${toB64(owner)}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const nameB64 = key.slice(ownerPrefix.length);
          names.push(fromB64(nameB64));
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
