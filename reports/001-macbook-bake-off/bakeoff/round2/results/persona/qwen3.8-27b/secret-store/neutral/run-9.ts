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

const SALT_KEY = "_master_salt";
const SECRET_PREFIX = "secret:";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
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

  // Get or generate the PBKDF2 salt
  const existingSalt = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (existingSalt !== undefined) {
    salt = fromBase64(existingSalt);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, toBase64(salt));
  }

  // Derive a 256-bit AES-GCM key from the master password
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const key: CryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  function secretStorageKey(owner: string, name: string): string {
    return `${SECRET_PREFIX}${encodeURIComponent(owner)}|${encodeURIComponent(name)}`;
  }

  // AAD binds the ciphertext to the specific (owner, name) so that
  // copying one secret's blob onto another's key will fail authentication.
  function aad(owner: string, name: string): Uint8Array {
    return encoder.encode(secretStorageKey(owner, name));
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(value);

      const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad(owner, name),
        },
        key,
        plaintext,
      );

      // Layout: [12-byte IV][ciphertext + 16-byte GCM tag]
      const ct = new Uint8Array(ciphertext);
      const blob = new Uint8Array(12 + ct.length);
      blob.set(iv, 0);
      blob.set(ct, 12);

      await storage.set(secretStorageKey(owner, name), toBase64(blob));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const raw = await storage.get(secretStorageKey(owner, name));
      if (raw === undefined) return undefined;

      try {
        const blob = fromBase64(raw);
        const iv = blob.slice(0, 12);
        const ct = blob.slice(12);

        const plaintext: ArrayBuffer = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad(owner, name),
          },
          key,
          ct,
        );

        return decoder.decode(plaintext);
      } catch {
        throw new Error("Tampered or invalid secret data");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = `${SECRET_PREFIX}${encodeURIComponent(owner)}|`;
      const allKeys = await storage.keys();

      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const encodedName = k.slice(prefix.length);
          names.push(decodeURIComponent(encodedName));
        }
      }

      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const sk = secretStorageKey(owner, name);
      const raw = await storage.get(sk);
      if (raw === undefined) return false;
      await storage.delete(sk);
      return true;
    },
  };
}
