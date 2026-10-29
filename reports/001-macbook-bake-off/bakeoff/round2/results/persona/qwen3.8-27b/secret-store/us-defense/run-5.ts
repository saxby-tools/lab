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
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Retrieve or generate the PBKDF2 salt
  let salt: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);
  if (storedSalt !== undefined) {
    salt = base64ToBytes(storedSalt);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, bytesToBase64(salt));
  }

  // Derive a 256-bit AES-GCM key from the master password
  const passwordBuf = enc.encode(masterPassword);
  const pbkdf2Base = await crypto.subtle.importKey(
    "raw",
    passwordBuf,
    { name: "PBKDF2" },
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
    pbkdf2Base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  function storageKeyFor(owner: string, name: string): string {
    const ownerB64 = bytesToBase64(enc.encode(owner));
    const nameB64 = bytesToBase64(enc.encode(name));
    return `secret:${ownerB64}:${nameB64}`;
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plainBytes = enc.encode(value);

      const cipherBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        plainBytes,
      );

      // Prepend the 12-byte IV to ciphertext (which already carries the 16-byte GCM tag)
      const combined = new Uint8Array(12 + cipherBuf.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(cipherBuf), 12);

      await storage.set(storageKeyFor(owner, name), bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const stored = await storage.get(storageKeyFor(owner, name));
      if (stored === undefined) return undefined;

      let combined: Uint8Array;
      try {
        combined = base64ToBytes(stored);
      } catch {
        throw new Error("Corrupted secret data: invalid encoding");
      }

      // Need at least 12 bytes of IV + 16 bytes of GCM tag
      if (combined.length <= 12) {
        throw new Error("Corrupted secret data: too short");
      }

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);

      try {
        const plainBuf = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          aesKey,
          ciphertext,
        );
        return dec.decode(plainBuf);
      } catch {
        throw new Error("Decryption failed: secret has been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerB64 = bytesToBase64(enc.encode(owner));
      const prefix = `secret:${ownerB64}:`;

      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const nameB64 = k.slice(prefix.length);
          try {
            names.push(dec.decode(base64ToBytes(nameB64)));
          } catch {
            // skip malformed entries from tampering
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKeyFor(owner, name);
      const exists = await storage.get(key);
      if (exists === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}

// --- helpers ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
