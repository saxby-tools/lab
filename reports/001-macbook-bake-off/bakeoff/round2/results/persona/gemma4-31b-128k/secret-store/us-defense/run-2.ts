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
 * Production-quality Secret Store implementation for Deno 2.
 * Uses PBKDF2 for key derivation and AES-GCM for authenticated encryption.
 * To prevent "secret swapping" attacks, owner and name are bound to the ciphertext
 * as Additional Authenticated Data (AAD).
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // --- Constants ---
  const SALT_KEY = "__system_salt__";
  const VALIDATION_KEY = "__system_validation__";
  const PBKDF2_ITERATIONS = 100_000;
  const AES_GCM_IV_LENGTH = 12;
  const VALIDATION_TEXT = "SECRET_STORE_VALIDATION_TOKEN";

  // --- Helpers for binary <-> string (Base64) ---
  const bufToBase64 = (buf: Uint8Array): string =>
    btoa(String.fromCharCode(...buf));

  const base64ToBuf = (str: string): Uint8Array =>
    Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  // --- Key Derivation ---
  const deriveKey = async (salt: Uint8Array): Promise<CryptoKey> => {
    const baseKey = await crypto.subtle.importKey(
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
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  };

  // --- Setup & Validation ---
  let saltBuf: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);

  if (storedSalt === undefined) {
    saltBuf = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bufToBase64(saltBuf));
  } else {
    saltBuf = base64ToBuf(storedSalt);
  }

  const encryptionKey = await deriveKey(saltBuf);

  // Validation to ensure masterPassword is correct
  const storedValidation = await storage.get(VALIDATION_KEY);
  if (storedValidation === undefined) {
    // Initialize validation token
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(VALIDATION_KEY),
      },
      encryptionKey,
      encoder.encode(VALIDATION_TEXT),
    );
    const payload = new Uint8Array(iv.length + encrypted.byteLength);
    payload.set(iv);
    payload.set(new Uint8Array(encrypted), iv.length);
    await storage.set(VALIDATION_KEY, bufToBase64(payload));
  } else {
    // Verify existing validation token
    try {
      const payload = base64ToBuf(storedValidation);
      const iv = payload.slice(0, AES_GCM_IV_LENGTH);
      const data = payload.slice(AES_GCM_IV_LENGTH);
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(VALIDATION_KEY),
        },
        encryptionKey,
        data,
      );
      if (decoder.decode(decrypted) !== VALIDATION_TEXT) {
        throw new Error("Master password verification failed.");
      }
    } catch (e) {
      throw new Error("Invalid master password or corrupted store.");
    }
  }

  // --- Storage Key Mapping ---
  // We use base64 encoding for owner and name to avoid collisions with separators
  const getStorageKey = (owner: string, name: string): string => {
    return `${bufToBase64(encoder.encode(owner))}:${bufToBase64(encoder.encode(name))}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
      // Use owner + name as AAD to prevent swapping secrets between users/names
      const aad = encoder.encode(`${owner}:${name}`);
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
        },
        encryptionKey,
        encoder.encode(value),
      );

      const payload = new Uint8Array(iv.length + ciphertext.byteLength);
      payload.set(iv);
      payload.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(getStorageKey(owner, name), bufToBase64(payload));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storedValue = await storage.get(getStorageKey(owner, name));
      if (storedValue === undefined) return undefined;

      try {
        const payload = base64ToBuf(storedValue);
        if (payload.length < AES_GCM_IV_LENGTH) throw new Error("Corrupted data");

        const iv = payload.slice(0, AES_GCM_IV_LENGTH);
        const data = payload.slice(AES_GCM_IV_LENGTH);
        const aad = encoder.encode(`${owner}:${name}`);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad,
          },
          encryptionKey,
          data,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws if the authentication tag is invalid (tampering or wrong key)
        throw new Error("Tampering detected or decryption failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = bufToBase64(encoder.encode(owner)) + ":";
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const nameB64 = key.slice(ownerPrefix.length);
          names.push(decoder.decode(base64ToBuf(nameB64)));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key) !== undefined;
      if (exists) {
        await storage.delete(key);
      }
      return exists;
    },
  };
}
