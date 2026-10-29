/**
 * Secret Store Implementation
 * 
 * Security Design:
 * 1. Key Derivation: Uses PBKDF2-HMAC-SHA256 to derive a high-entropy 256-bit key from the master password.
 * 2. Encryption: Uses AES-GCM (Authenticated Encryption with Associated Data).
 * 3. Tamper Detection: AES-GCM provides an authentication tag. If any bit of the ciphertext or 
 *    the Associated Data is changed, decryption fails.
 * 4. Isolation: The owner and secret name are passed as Additional Authenticated Data (AAD).
 *    This ensures that a ciphertext cannot be moved from one owner/name slot to another 
 *    without triggering a tampering error.
 * 5. Verification: A canary value is stored and encrypted to verify the master password upon initialization.
 */

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

const SALT_KEY = "sys:salt";
const CANARY_KEY = "sys:canary";
const SECRET_PREFIX = "sec:";
const DELIMITER = "\x00"; // Use null byte to safely separate owner and name
const PBKDF2_ITERATIONS = 100000;

function bufToBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

function base64ToBuf(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  // 1. Handle Salt
  let saltStr = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (saltStr === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bufToBase64(salt));
  } else {
    salt = base64ToBuf(saltStr);
  }

  // 2. Derive Master Key
  const passwordKey = await crypto.subtle.importKey(
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
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Verify Master Password via Canary
  const canaryEncrypted = await storage.get(CANARY_KEY);
  if (canaryEncrypted === undefined) {
    // First time setup: create canary
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode("canary") },
      masterKey,
      encoder.encode("verified"),
    );
    const payload = new Uint8Array(iv.length + encrypted.byteLength);
    payload.set(iv);
    payload.set(new Uint8Array(encrypted), iv.length);
    await storage.set(CANARY_KEY, bufToBase64(payload));
  } else {
    // Verify existing password
    try {
      const payload = base64ToBuf(canaryEncrypted);
      const iv = payload.slice(0, 12);
      const data = payload.slice(12);
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode("canary") },
        masterKey,
        data,
      );
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(owner + DELIMITER + name);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        masterKey,
        encoder.encode(value),
      );

      const payload = new Uint8Array(iv.length + ciphertext.byteLength);
      payload.set(iv);
      payload.set(new Uint8Array(ciphertext), iv.length);

      const storageKey = `${SECRET_PREFIX}${owner}${DELIMITER}${name}`;
      await storage.set(storageKey, bufToBase64(payload));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `${SECRET_PREFIX}${owner}${DELIMITER}${name}`;
      const encryptedBase64 = await storage.get(storageKey);
      if (encryptedBase64 === undefined) return undefined;

      try {
        const payload = base64ToBuf(encryptedBase64);
        const iv = payload.slice(0, 12);
        const data = payload.slice(12);
        const aad = encoder.encode(owner + DELIMITER + name);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          masterKey,
          data,
        );
        return new TextDecoder().decode(decrypted);
      } catch (e) {
        // Tampering detected or key mismatch
        throw new Error("Secret data has been tampered with or is corrupted");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `${SECRET_PREFIX}${owner}${DELIMITER}`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const name = key.slice(ownerPrefix.length);
          if (name.length > 0) {
            names.push(name);
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `${SECRET_PREFIX}${owner}${DELIMITER}${name}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;
      
      await storage.delete(storageKey);
      return true;
    },
  };
}
