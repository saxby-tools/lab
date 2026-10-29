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
 * Utility to convert Uint8Array to Base64 and vice versa.
 * Avoids stack overflow on large arrays by avoiding spread syntax.
 */
const b64Encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const b64Decode = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Encodes user strings into a safe format for storage keys.
 * Uses TextEncoder + Base64 to support all Unicode characters.
 */
const encodeKeyPart = (str: string): string => {
  return b64Encode(new TextEncoder().encode(str));
};

const decodeKeyPart = (b64: string): string => {
  return new TextDecoder().decode(b64Decode(b64));
};

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // 1. Handle Salt Management
  const SALT_KEY = "__store_salt__";
  const CANARY_KEY = "__store_canary__";
  let saltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;

  if (saltB64) {
    salt = b64Decode(saltB64);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, b64Encode(salt));
  }

  // 2. Derive the Master Key using PBKDF2
  // We use SHA-256 and 100,000 iterations for strong key derivation.
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const masterKey = await crypto.subtle.deriveKey(
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

  // 3. Password Verification (Canary)
  // If the store already exists, verify that the masterPassword is correct.
  const canaryValue = await storage.get(CANARY_KEY);
  if (canaryValue) {
    try {
      await decryptValue(masterKey, CANARY_KEY, CANARY_KEY, canaryValue);
    } catch (e) {
      throw new Error("Invalid master password");
    }
  } else {
    // First-time setup: store an encrypted canary to validate future password attempts.
    const canaryText = "verified";
    const encryptedCanary = await encryptValue(masterKey, CANARY_KEY, CANARY_KEY, canaryText);
    await storage.set(CANARY_KEY, encryptedCanary);
  }

  return {
    async put(owner, name, value) {
      const key = `secret:${encodeKeyPart(owner)}:${encodeKeyPart(name)}`;
      const encrypted = await encryptValue(masterKey, owner, name, value);
      await storage.set(key, encrypted);
    },

    async get(owner, name) {
      const key = `secret:${encodeKeyPart(owner)}:${encodeKeyPart(name)}`;
      const encrypted = await storage.get(key);
      if (encrypted === undefined) return undefined;

      try {
        return await decryptValue(masterKey, owner, name, encrypted);
      } catch (e) {
        // Tampering detected: AES-GCM throws if the tag is invalid or AAD doesn't match.
        throw new Error("Secret tampering detected or decryption failed");
      }
    },

    async list(owner) {
      const prefix = `secret:${encodeKeyPart(owner)}:`;
      const allKeys = await storage.keys();
      const ownerKeys = allKeys.filter((k) => k.startsWith(prefix));

      const names = ownerKeys.map((k) => {
        const parts = k.split(":");
        // The last part is the encoded name.
        return decodeKeyPart(parts[parts.length - 1]);
      });

      return names.sort();
    },

    async remove(owner, name) {
      const key = `secret:${encodeKeyPart(owner)}:${encodeKeyPart(name)}`;
      const exists = await storage.get(key);
      if (!exists) return false;

      await storage.delete(key);
      return true;
    },
  };
}

/**
 * AES-GCM Encryption
 * AAD is used to tie the ciphertext to a specific owner and name, 
 * preventing "cut-and-paste" attacks across different users or secrets.
 */
async function encryptValue(
  key: CryptoKey,
  owner: string,
  name: string,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();

  // AAD (Additional Authenticated Data) ensures the encrypted blob cannot be 
  // moved to a different owner or name without detection.
  const aad = encoder.encode(`${owner}:${name}`);
  const plaintext = encoder.encode(value);

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
    },
    key,
    plaintext,
  );

  // Store IV + Ciphertext together.
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return b64Encode(combined);
}

/**
 * AES-GCM Decryption
 */
async function decryptValue(
  key: CryptoKey,
  owner: string,
  name: string,
  encryptedB64: string,
): Promise<string> {
  const combined = b64Decode(encryptedB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const encoder = new TextEncoder();
  const aad = encoder.encode(`${owner}:${name}`);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
    },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}
