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

  const SALT_KEY = "__secret_store_salt__";
  const PREFIX = "s:";
  const IV_LENGTH = 12;
  const PBKDF2_ITERATIONS = 100_000;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function stringToBase64(s: string): string {
    return bytesToBase64(encoder.encode(s));
  }

  function base64ToString(b64: string): string {
    return decoder.decode(base64ToBytes(b64));
  }

  function makeKey(owner: string, name: string): string {
    return `${PREFIX}${stringToBase64(owner)}:${stringToBase64(name)}`;
  }

  // Retrieve or create the PBKDF2 salt.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = base64ToBytes(saltB64);

  // Derive the AES-256-GCM key from the master password.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const cryptoKey: CryptoKey = await crypto.subtle.deriveKey(
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

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = makeKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const plaintext = encoder.encode(value);
      // AAD binds the ciphertext to this specific owner+name key,
      // so copying another secret's blob here will fail authentication.
      const aad = encoder.encode(key);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        cryptoKey,
        plaintext,
      );

      // Store: IV (12 bytes) || ciphertext+tag
      const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), IV_LENGTH);

      await storage.set(key, bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = makeKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      try {
        const combined = base64ToBytes(stored);
        if (combined.length < IV_LENGTH + 16) {
          throw new Error("Corrupted secret data");
        }

        const iv = combined.slice(0, IV_LENGTH);
        const ciphertext = combined.slice(IV_LENGTH);
        const aad = encoder.encode(key);

        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          cryptoKey,
          ciphertext,
        );

        return decoder.decode(plaintext);
      } catch (_e) {
        throw new Error("Secret integrity check failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = `${PREFIX}${stringToBase64(owner)}:`;
      const allKeys = await storage.keys();
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const nameB64 = key.slice(prefix.length);
          try {
            names.push(base64ToString(nameB64));
          } catch {
            // Skip keys with malformed base64 in the name portion.
          }
        }
      }

      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = makeKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
