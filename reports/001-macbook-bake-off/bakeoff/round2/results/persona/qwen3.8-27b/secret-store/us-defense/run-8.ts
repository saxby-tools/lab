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
  const SECRET_PREFIX = "secret:";

  // Obtain or create the PBKDF2 salt so that a re-created store with the
  // same master password derives the same key.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }

  const salt = base64ToBytes(saltB64);

  // Derive a 256-bit AES-GCM key from the master password.
  const passwordBytes = new TextEncoder().encode(masterPassword);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Storage key for a given (owner, name) pair.
  // JSON.stringify([owner, name]) is a canonical, collision-free encoding
  // that handles any characters (colons, slashes, newlines, etc.).
  function storageKey(owner: string, name: string): string {
    return SECRET_PREFIX + JSON.stringify([owner, name]);
  }

  // Additional authenticated data binds the ciphertext to its (owner, name)
  // so that copying a blob to a different location will fail authentication.
  function aad(owner: string, name: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify([owner, name]));
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(value);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", nonce, additionalData: aad(owner, name) },
        aesKey,
        plaintext,
      );
      // Layout on disk: nonce (12 bytes) ‖ ciphertext-with-tag
      const combined = new Uint8Array(12 + ciphertext.byteLength);
      combined.set(nonce, 0);
      combined.set(new Uint8Array(ciphertext), 12);
      await storage.set(storageKey(owner, name), bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = storageKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      try {
        const combined = base64ToBytes(stored);
        // Minimum: 12-byte nonce + 16-byte GCM tag
        if (combined.length < 28) {
          throw new Error("Corrupt secret data");
        }
        const nonce = combined.subarray(0, 12);
        const ciphertext = combined.subarray(12);
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", nonce, additionalData: aad(owner, name) },
          aesKey,
          ciphertext,
        );
        return new TextDecoder().decode(decrypted);
      } catch (_e) {
        // Any failure here means the data is tampered, the password is
        // wrong, or the blob is malformed.
        throw new Error("Secret decryption failed: data may have been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (!k.startsWith(SECRET_PREFIX)) continue;
        try {
          const parsed: unknown = JSON.parse(k.slice(SECRET_PREFIX.length));
          if (
            Array.isArray(parsed) &&
            parsed.length === 2 &&
            parsed[0] === owner &&
            typeof parsed[1] === "string"
          ) {
            names.push(parsed[1] as string);
          }
        } catch {
          // Ignore keys that don't match our schema.
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
