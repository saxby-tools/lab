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
 * A production-quality Secret Store implementation using the Web Crypto API.
 * Uses AES-GCM for authenticated encryption and PBKDF2 for key derivation.
 * 
 * Security Design:
 * 1. Key Derivation: PBKDF2-HMAC-SHA256 derives a 256-bit key from the master password and a stored salt.
 * 2. Confidentiality: AES-GCM encrypts values at rest.
 * 3. Integrity/Isolation: Owner and Name are passed as Additional Authenticated Data (AAD).
 *    This prevents "copy-paste" attacks where an encrypted blob is moved from one secret key to another.
 * 4. Tamper Detection: AES-GCM's authentication tag ensures any modification results in a decryption failure.
 * 5. Password Verification: A canary value is stored to verify the master password during initialization.
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  const SALT_KEY = "__salt__";
  const CANARY_KEY = "__canary__";
  const CANARY_VALUE = "verified";

  // --- Helpers for Encoding ---
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const toB64 = (buf: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < buf.byteLength; i++) binary += String.fromCharCode(buf[i]);
    return btoa(binary);
  };

  const fromB64 = (str: string): Uint8Array => {
    const bin = atob(str);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };

  const b64EncodeStr = (str: string) => toB64(encoder.encode(str));

  // --- Key Derivation ---
  let salt: Uint8Array;
  const existingSalt = await storage.get(SALT_KEY);

  if (existingSalt === undefined) {
    // New store: initialize salt and canary
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, toB64(salt));
  } else {
    salt = fromB64(existingSalt);
  }

  // Import password as a raw key for PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  // Derive AES-GCM key
  const cryptoKey = await crypto.subtle.deriveKey(
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

  // --- Canary Verification ---
  const existingCanary = await storage.get(CANARY_KEY);
  if (existingCanary === undefined) {
    // First time setup: encrypt and store the canary
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      encoder.encode(CANARY_VALUE),
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    await storage.set(CANARY_KEY, toB64(combined));
  } else {
    // Verify existing password by attempting to decrypt canary
    try {
      const data = fromB64(existingCanary);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        ciphertext,
      );
      if (decoder.decode(decrypted) !== CANARY_VALUE) {
        throw new Error("Password verification failed");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  // --- Store Implementation ---
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(`${owner}:${name}`);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        cryptoKey,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);

      const storageKey = `secret:${b64EncodeStr(owner)}:${b64EncodeStr(name)}`;
      await storage.set(storageKey, toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secret:${b64EncodeStr(owner)}:${b64EncodeStr(name)}`;
      const encryptedB64 = await storage.get(storageKey);

      if (encryptedB64 === undefined) return undefined;

      try {
        const data = fromB64(encryptedB64);
        const iv = data.slice(0, 12);
        const ciphertext = data.slice(12);
        const aad = encoder.encode(`${owner}:${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          cryptoKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws OperationError if authentication tag is invalid (tampering)
        throw new Error("Secret decryption failed: Data may have been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `secret:${b64EncodeStr(owner)}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          // The key format is secret:ownerB64:nameB64
          const nameB64 = parts[2];
          if (nameB64) {
            names.push(decoder.decode(fromB64(nameB64)));
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secret:${b64EncodeStr(owner)}:${b64EncodeStr(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
