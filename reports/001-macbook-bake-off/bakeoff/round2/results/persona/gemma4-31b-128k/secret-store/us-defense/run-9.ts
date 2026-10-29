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
function bufToB64(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf));
}

/**
 * Helper to convert Base64 string to Uint8Array
 */
function b64ToBuf(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * Derives a cryptographically strong AES-GCM key from a master password using PBKDF2.
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
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
}

/**
 * Authenticated encryption using AES-GCM.
 * Stores IV prefixed to the ciphertext.
 * AAD is used to bind the ciphertext to the specific owner and name to prevent swapping.
 */
async function encrypt(key: CryptoKey, value: string, aad: string): Promise<string> {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(aad),
    },
    key,
    encoder.encode(value),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bufToB64(combined);
}

/**
 * Authenticated decryption using AES-GCM.
 * Throws Error if tampering is detected or AAD does not match.
 */
async function decrypt(key: CryptoKey, encryptedB64: string, aad: string): Promise<string> {
  const combined = b64ToBuf(encryptedB64);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const encoder = new TextEncoder();

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(aad),
    },
    key,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  const SALT_KEY = "__store_salt__";
  const CANARY_KEY = "__store_canary__";
  const CANARY_VALUE = "SECRET_STORE_CANARY_VERIFICATION";

  const saltB64 = await storage.get(SALT_KEY);
  let derivedKey: CryptoKey;

  if (saltB64 === undefined) {
    // First time initialization
    const salt = crypto.getRandomValues(new Uint8Array(16));
    derivedKey = await deriveKey(masterPassword, salt);
    
    // Store salt and an encrypted canary to verify the password in the future
    const canaryEncrypted = await encrypt(derivedKey, CANARY_VALUE, "CANARY");
    await storage.set(SALT_KEY, bufToB64(salt));
    await storage.set(CANARY_KEY, canaryEncrypted);
  } else {
    // Existing store: verify password against canary
    const salt = b64ToBuf(saltB64);
    derivedKey = await deriveKey(masterPassword, salt);
    const canaryEncrypted = await storage.get(CANARY_KEY);

    if (canaryEncrypted === undefined) {
      throw new Error("Storage corrupted: missing canary");
    }

    try {
      const decryptedCanary = await decrypt(derivedKey, canaryEncrypted, "CANARY");
      if (decryptedCanary !== CANARY_VALUE) {
        throw new Error("Invalid master password");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const aad = `${owner}\0${name}`;
      const ciphertext = await encrypt(derivedKey, value, aad);
      await storage.set(storageKey, ciphertext);
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const ciphertext = await storage.get(storageKey);
      if (ciphertext === undefined) return undefined;

      const aad = `${owner}\0${name}`;
      try {
        return await decrypt(derivedKey, ciphertext, aad);
      } catch (e) {
        throw new Error("Tampering detected: secret value has been modified or moved");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `secret:${btoa(owner)}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const nameB64 = key.substring(prefix.length);
          names.push(atob(nameB64));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secret:${btoa(owner)}:${btoa(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
