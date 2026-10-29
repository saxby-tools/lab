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
 * Helper to convert Uint8Array to Base64 string safely without stack overflow
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Helper to convert Base64 string to Uint8Array
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
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
  const decoder = new TextDecoder();

  // System constants
  const SALT_KEY = "__sys_salt__";
  const VERIFY_KEY = "__sys_verify__";
  const CANARY_TEXT = "MASTER_KEY_VERIFICATION_CANARY";

  let salt: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);

  if (storedSalt === undefined) {
    // First time initialization
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, toBase64(salt));
  } else {
    salt = fromBase64(storedSalt);
  }

  // Derive the master key using PBKDF2
  const pwKeyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
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
    pwKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Verify the master password using a canary value
  const storedCanary = await storage.get(VERIFY_KEY);
  if (storedCanary === undefined) {
    // Create the canary for future verification
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedCanary = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      masterKey,
      encoder.encode(CANARY_TEXT),
    );
    const payload = new Uint8Array(iv.length + encryptedCanary.byteLength);
    payload.set(iv);
    payload.set(new Uint8Array(encryptedCanary), iv.length);
    await storage.set(VERIFY_KEY, toBase64(payload));
  } else {
    // Validate existing canary
    try {
      const payload = fromBase64(storedCanary);
      const iv = payload.slice(0, 12);
      const data = payload.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        masterKey,
        data,
      );
      if (decoder.decode(decrypted) !== CANARY_TEXT) {
        throw new Error("Invalid master password");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return {
    async put(owner, name, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // AAD (Additional Authenticated Data) binds the ciphertext to the owner and name.
      // This prevents an attacker from moving a valid ciphertext from one secret to another.
      const aad = encoder.encode(`${owner}:${name}`);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        masterKey,
        encoder.encode(value),
      );

      const payload = new Uint8Array(iv.length + encrypted.byteLength);
      payload.set(iv);
      payload.set(new Uint8Array(encrypted), iv.length);

      const storageKey = `secret:${toBase64(encoder.encode(owner))}:${toBase64(encoder.encode(name))}`;
      await storage.set(storageKey, toBase64(payload));
    },

    async get(owner, name) {
      const storageKey = `secret:${toBase64(encoder.encode(owner))}:${toBase64(encoder.encode(name))}`;
      const storedValue = await storage.get(storageKey);
      if (storedValue === undefined) return undefined;

      try {
        const payload = fromBase64(storedValue);
        const iv = payload.slice(0, 12);
        const data = payload.slice(12);
        const aad = encoder.encode(`${owner}:${name}`);
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          masterKey,
          data,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // Tampering detected or key mismatch
        throw new Error("Secret tampering detected or invalid key");
      }
    },

    async list(owner) {
      const allKeys = await storage.keys();
      const ownerPrefix = `secret:${toBase64(encoder.encode(owner))}:`;
      const secretNames: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const nameB64 = key.substring(ownerPrefix.length);
          secretNames.push(decoder.decode(fromBase64(nameB64)));
        }
      }

      return secretNames.sort();
    },

    async remove(owner, name) {
      const storageKey = `secret:${toBase64(encoder.encode(owner))}:${toBase64(encoder.encode(name))}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
