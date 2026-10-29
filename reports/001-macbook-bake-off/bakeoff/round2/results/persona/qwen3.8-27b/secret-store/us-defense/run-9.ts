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

const SALT_KEY = "__secret_store_salt__";
const SECRET_PREFIX = "secret.";
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 600_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  let pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function makeStorageKey(owner: string, name: string): string {
  const enc = new TextEncoder();
  const ownerB64 = toBase64Url(enc.encode(owner));
  const nameB64 = toBase64Url(enc.encode(name));
  return SECRET_PREFIX + ownerB64 + "." + nameB64;
}

export function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  async function deriveKey(): Promise<CryptoKey> {
    let saltB64 = await storage.get(SALT_KEY);
    let salt: Uint8Array;

    if (saltB64 === undefined) {
      salt = crypto.getRandomValues(new Uint8Array(32));
      await storage.set(SALT_KEY, toBase64Url(salt));
    } else {
      salt = fromBase64Url(saltB64);
    }

    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(masterPassword),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      256,
    );

    return crypto.subtle.importKey(
      "raw",
      bits,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  let key: CryptoKey;
  try {
    key = await deriveKey();
  } catch {
    throw new Error("Failed to derive encryption key");
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const storageKey = makeStorageKey(owner, name);
      const enc = new TextEncoder();
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const plaintext = enc.encode(value);
      const aad = enc.encode(storageKey);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: aad,
        },
        key,
        plaintext,
      );

      const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), IV_LENGTH);

      await storage.set(storageKey, toBase64Url(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = makeStorageKey(owner, name);
      const stored = await storage.get(storageKey);
      if (stored === undefined) return undefined;

      let combined: Uint8Array;
      try {
        combined = fromBase64Url(stored);
      } catch {
        throw new Error("Corrupt secret data: invalid encoding");
      }

      if (combined.length < IV_LENGTH + 16) {
        throw new Error("Corrupt secret data: ciphertext too short");
      }

      const iv = combined.slice(0, IV_LENGTH);
      const ciphertext = combined.slice(IV_LENGTH);
      const enc = new TextEncoder();
      const aad = enc.encode(storageKey);

      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: aad,
          },
          key,
          ciphertext,
        );
      } catch {
        throw new Error("Authentication failure: secret may have been tampered with");
      }

      return new TextDecoder().decode(plaintext);
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const enc = new TextEncoder();
      const ownerB64 = toBase64Url(enc.encode(owner));
      const ownerPrefix = SECRET_PREFIX + ownerB64 + ".";
      const names: string[] = [];

      for (const k of allKeys) {
        if (k.startsWith(ownerPrefix)) {
          const nameB64 = k.slice(ownerPrefix.length);
          if (nameB64.length === 0) continue;
          try {
            const nameBytes = fromBase64Url(nameB64);
            names.push(new TextDecoder().decode(nameBytes));
          } catch {
            // Skip entries that cannot be decoded (possibly tampered keys)
          }
        }
      }

      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = makeStorageKey(owner, name);
      const existing = await storage.get(storageKey);
      if (existing === undefined) return false;
      await storage.delete(storageKey);
      return true;
    },
  };
}
