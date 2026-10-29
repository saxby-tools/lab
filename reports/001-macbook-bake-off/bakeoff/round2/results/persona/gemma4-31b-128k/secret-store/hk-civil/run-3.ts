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
 * Utility to convert Uint8Array to Base64 string without stack overflow on large buffers.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binString);
}

/**
 * Utility to convert Base64 string to Uint8Array.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (char) => char.charCodeAt(0));
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 1. Handle Master Key Derivation Salt
  let saltB64 = await options.storage.get("system:salt");
  let salt: Uint8Array;

  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await options.storage.set("system:salt", bytesToBase64(salt));
  } else {
    salt = base64ToBytes(saltB64);
  }

  // 2. Derive the AES-GCM key using PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Verify Master Password using a Canary
  const CANARY_TEXT = "SECRET_STORE_VERIFIED";
  const CANARY_KEY = "system:canary";
  const storedCanaryB64 = await options.storage.get(CANARY_KEY);

  if (storedCanaryB64 === undefined) {
    // Initialize fresh store
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(CANARY_KEY) },
      aesKey,
      encoder.encode(CANARY_TEXT),
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    await options.storage.set(CANARY_KEY, bytesToBase64(combined));
  } else {
    // Validate existing store
    try {
      const combined = base64ToBytes(storedCanaryB64);
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(CANARY_KEY) },
        aesKey,
        data,
      );
      if (decoder.decode(decrypted) !== CANARY_TEXT) {
        throw new Error("Invalid master password");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  /**
   * Helper to generate the storage key based on owner and name.
   * We use Base64 to ensure any character in owner/name is handled correctly.
   */
  const getStorageKey = (owner: string, name: string): string => {
    return `s:${bytesToBase64(encoder.encode(owner))}:${bytesToBase64(encoder.encode(name))}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ad = encoder.encode(`${owner}:${name}`);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: ad },
        aesKey,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);

      await options.storage.set(getStorageKey(owner, name), bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const b64Data = await options.storage.get(getStorageKey(owner, name));
      if (b64Data === undefined) return undefined;

      try {
        const combined = base64ToBytes(b64Data);
        if (combined.length < 12) throw new Error("Corrupt data");

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const ad = encoder.encode(`${owner}:${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: ad },
          aesKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Tampering detected or wrong key
        throw new Error("Secret decryption failed: data may be tampered with or corrupted");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await options.storage.keys();
      const ownerB64 = bytesToBase64(encoder.encode(owner));
      const prefix = `s:${ownerB64}:`;

      const names = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => {
          const parts = k.split(":");
          // The 3rd part (index 2) is the b64 encoded name
          return decoder.decode(base64ToBytes(parts[2]));
        })
        .sort();

      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await options.storage.get(key);
      if (exists === undefined) return false;

      await options.storage.delete(key);
      return true;
    },
  };
}

