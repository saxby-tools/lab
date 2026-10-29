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
 * Helper to convert binary buffers to Base64 strings and vice versa.
 */
const BinCodec = {
  toBase64(buf: Uint8Array): string {
    return btoa(String.fromCharCode(...buf));
  },
  fromBase64(str: string): Uint8Array {
    const bin = atob(str);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  },
};

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  // Constants for KDF and Encryption
  const SALT_KEY = "__ss_salt__";
  const VERIFY_KEY = "__ss_verify__";
  const ITERATIONS = 100_000;
  const AES_ALGO = "AES-GCM";

  // 1. Handle Master Key Derivation
  let saltBytes = await storage.get(SALT_KEY);
  let isNewStore = false;

  if (saltBytes === undefined) {
    // Initialize new store
    saltBytes = BinCodec.toBase64(crypto.getRandomValues(new Uint8Array(16)));
    await storage.set(SALT_KEY, saltBytes);
    isNewStore = true;
  }

  const salt = BinCodec.fromBase64(saltBytes);
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
      salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: AES_ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 2. Verify Master Password
  // We store a canary value to ensure the password is correct.
  const verifyVal = "SECRET_STORE_VERIFIED";
  const verifyAAD = encoder.encode("system|verify");

  if (isNewStore) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: AES_ALGO, iv, additionalData: verifyAAD },
      masterKey,
      encoder.encode(verifyVal),
    );
    const payload = new Uint8Array(iv.length + encrypted.byteLength);
    payload.set(iv);
    payload.set(new Uint8Array(encrypted), iv.length);
    await storage.set(VERIFY_KEY, BinCodec.toBase64(payload));
  } else {
    const storedVerify = await storage.get(VERIFY_KEY);
    if (storedVerify === undefined) {
      throw new Error("Store corruption detected: verification key missing.");
    }
    try {
      const data = BinCodec.fromBase64(storedVerify);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: AES_ALGO, iv, additionalData: verifyAAD },
        masterKey,
        ciphertext,
      );
      if (new TextDecoder().decode(decrypted) !== verifyVal) {
        throw new Error();
      }
    } catch (e) {
      throw new Error("Invalid master password or corrupted storage.");
    }
  }

  // 3. Implement SecretStore interface
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(`${owner}|${name}`);
      const ciphertext = await crypto.subtle.encrypt(
        { name: AES_ALGO, iv, additionalData: aad },
        masterKey,
        encoder.encode(value),
      );
      
      const payload = new Uint8Array(iv.length + ciphertext.byteLength);
      payload.set(iv);
      payload.set(new Uint8Array(ciphertext), iv.length);
      
      // Store key is constructed from Base64 owner/name to allow any char
      const storageKey = `s:${BinCodec.toBase64(encoder.encode(owner))}:${BinCodec.toBase64(encoder.encode(name))}`;
      await storage.set(storageKey, BinCodec.toBase64(payload));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `s:${BinCodec.toBase64(encoder.encode(owner))}:${BinCodec.toBase64(encoder.encode(name))}`;
      const stored = await storage.get(storageKey);
      if (stored === undefined) return undefined;

      try {
        const data = BinCodec.fromBase64(stored);
        const iv = data.slice(0, 12);
        const ciphertext = data.slice(12);
        const aad = encoder.encode(`${owner}|${name}`);
        
        const decrypted = await crypto.subtle.decrypt(
          { name: AES_ALGO, iv, additionalData: aad },
          masterKey,
          ciphertext,
        );
        return new TextDecoder().decode(decrypted);
      } catch (e) {
        // AES-GCM throws OperationError if authentication tag is invalid
        throw new Error("Tampering detected: secret value is invalid or has been moved.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `s:${BinCodec.toBase64(encoder.encode(owner))}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const b64Name = key.slice(ownerPrefix.length);
          const name = new TextDecoder().decode(BinCodec.fromBase64(b64Name));
          names.push(name);
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `s:${BinCodec.toBase64(encoder.encode(owner))}:${BinCodec.toBase64(encoder.encode(name))}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;
      
      await storage.delete(storageKey);
      return true;
    },
  };
}
