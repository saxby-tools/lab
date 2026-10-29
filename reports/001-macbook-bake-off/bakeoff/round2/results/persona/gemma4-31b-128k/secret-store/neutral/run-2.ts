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

  // Constants for key derivation and encryption
  const SALT_KEY = "__system_salt__";
  const VERIFY_KEY = "__system_verify__";
  const PBKDF2_ITERATIONS = 100000;
  const AES_ALGO = "AES-GCM";
  const PBKDF2_ALGO = "PBKDF2";
  const HASH_ALGO = "SHA-256";

  // Helpers for Base64 encoding/decoding of binary data
  const toB64 = (buf: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return btoa(binary);
  };

  const fromB64 = (str: string): Uint8Array => {
    const binary = atob(str);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf;
  };

  // Derive a CryptoKey from the master password and a salt
  async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(masterPassword),
      { name: PBKDF2_ALGO },
      false,
      ["deriveKey"],
    );

    return crypto.subtle.deriveKey(
      {
        name: PBKDF2_ALGO,
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: HASH_ALGO,
      },
      passwordKey,
      { name: AES_ALGO, length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  // Initialize or verify the master key
  const storedSaltB64 = await storage.get(SALT_KEY);
  let masterKey: CryptoKey;

  if (!storedSaltB64) {
    // New store initialization
    const salt = crypto.getRandomValues(new Uint8Array(16));
    masterKey = await deriveKey(salt);

    // Create a verification token to ensure future passwords are correct
    const verifyPlaintext = encoder.encode("VERIFICATION_TOKEN");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedVerify = await crypto.subtle.encrypt(
      { name: AES_ALGO, iv, additionalData: encoder.encode("VERIFY") },
      masterKey,
      verifyPlaintext,
    );

    const verifyPayload = new Uint8Array(iv.length + encryptedVerify.byteLength);
    verifyPayload.set(iv);
    verifyPayload.set(new Uint8Array(encryptedVerify), iv.length);

    await storage.set(SALT_KEY, toB64(salt));
    await storage.set(VERIFY_KEY, toB64(verifyPayload));
  } else {
    // Existing store: derive key and verify password
    const salt = fromB64(storedSaltB64);
    masterKey = await deriveKey(salt);

    const storedVerifyB64 = await storage.get(VERIFY_KEY);
    if (!storedVerifyB64) throw new Error("Store corrupted: verification token missing");

    const verifyPayload = fromB64(storedVerifyB64);
    const iv = verifyPayload.slice(0, 12);
    const ciphertext = verifyPayload.slice(12);

    try {
      await crypto.subtle.decrypt(
        { name: AES_ALGO, iv, additionalData: encoder.encode("VERIFY") },
        masterKey,
        ciphertext,
      );
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  // Helper to create a unique storage key that handles any char in owner/name
  // Using a null byte as a delimiter as it's uncommon in identifiers
  const getStorageKey = (owner: string, name: string) => `sec:${owner}\u0000${name}`;

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const storageKey = getStorageKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(storageKey);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: AES_ALGO, iv, additionalData: aad },
        masterKey,
        plaintext,
      );

      const payload = new Uint8Array(iv.length + ciphertext.byteLength);
      payload.set(iv);
      payload.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(storageKey, toB64(payload));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = getStorageKey(owner, name);
      const dataB64 = await storage.get(storageKey);
      if (dataB64 === undefined) return undefined;

      const payload = fromB64(dataB64);
      if (payload.length < 28) throw new Error("Tampering detected: payload too short");

      const iv = payload.slice(0, 12);
      const ciphertext = payload.slice(12);
      const aad = encoder.encode(storageKey);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: AES_ALGO, iv, additionalData: aad },
          masterKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        throw new Error("Tampering detected");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `sec:${owner}\u0000`;
      const results: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          results.push(key.slice(prefix.length));
        }
      }

      return results.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = getStorageKey(owner, name);
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
