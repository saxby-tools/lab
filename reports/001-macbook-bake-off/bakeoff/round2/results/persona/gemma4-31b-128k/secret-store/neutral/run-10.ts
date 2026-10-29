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
 * Helper to convert Uint8Array to Base64 string
 */
function bufToBase64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

/**
 * Helper to convert Base64 string to Uint8Array
 */
function base64ToBuf(str: string): Uint8Array {
  const bin = atob(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    buf[i] = bin.charCodeAt(i);
  }
  return buf;
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Constants for key derivation and encryption
  const SALT_KEY = "__salt__";
  const CANARY_KEY = "__canary__";
  const SECRET_PREFIX = "sec:";
  const PBKDF2_ITERATIONS = 100000;
  const AES_GCM_IV_LENGTH = 12;

  // 1. Resolve or Create Salt
  let saltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bufToBase64(salt));
  } else {
    salt = base64ToBuf(saltB64);
  }

  // 2. Derive Cryptographic Key from Master Password
  async function deriveKey(): Promise<CryptoKey> {
    const pwKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(masterPassword),
      "PBKDF2",
      false,
      ["deriveKey"],
    );

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      pwKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  const key = await deriveKey();

  // 3. Verify Password via Canary
  const canaryVal = await storage.get(CANARY_KEY);
  if (canaryVal !== undefined) {
    try {
      const blob = base64ToBuf(canaryVal);
      const iv = blob.slice(0, AES_GCM_IV_LENGTH);
      const data = blob.slice(AES_GCM_IV_LENGTH);
      
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv, additionalData: encoder.encode("canary") },
        key,
        data
      );
    } catch (e) {
      throw new Error("Invalid master password");
    }
  } else {
    // First time setup: create canary to verify future password attempts
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv, additionalData: encoder.encode("canary") },
      key,
      encoder.encode("VERIFIED")
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    await storage.set(CANARY_KEY, bufToBase64(combined));
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
      // Include owner and name in Additional Authenticated Data (AAD) to prevent swapping/isolation breaches
      const ad = encoder.encode(owner + "\x00" + name);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: ad },
        key,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      
      const storageKey = `${SECRET_PREFIX}${btoa(owner)}:${btoa(name)}`;
      await storage.set(storageKey, bufToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `${SECRET_PREFIX}${btoa(owner)}:${btoa(name)}`;
      const encryptedB64 = await storage.get(storageKey);
      if (encryptedB64 === undefined) return undefined;

      const blob = base64ToBuf(encryptedB64);
      if (blob.length < AES_GCM_IV_LENGTH) throw new Error("Stored data is corrupted");

      const iv = blob.slice(0, AES_GCM_IV_LENGTH);
      const ciphertext = blob.slice(AES_GCM_IV_LENGTH);
      const ad = encoder.encode(owner + "\x00" + name);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: ad },
          key,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws if tag is invalid or AAD doesn't match
        throw new Error("Secret tampering detected or invalid key");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = btoa(owner);
      const names: string[] = [];

      for (const k of allKeys) {
        if (k.startsWith(SECRET_PREFIX)) {
          const parts = k.slice(SECRET_PREFIX.length).split(":");
          if (parts.length === 2 && parts[0] === ownerB64) {
            names.push(atob(parts[1]));
          }
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `${SECRET_PREFIX}${btoa(owner)}:${btoa(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
