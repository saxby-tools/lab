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

const SALT_KEY = "__ss_salt__";
const SECRET_PREFIX = "ss:";
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 100_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
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

function encodeKeyPart(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

function decodeKeyPart(s: string): string {
  return new TextDecoder().decode(base64ToBytes(s));
}

function makeSecretKey(owner: string, name: string): string {
  return SECRET_PREFIX + encodeKeyPart(owner) + ":" + encodeKeyPart(name);
}

function makeAad(owner: string, name: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([owner, name]));
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Retrieve or create the PBKDF2 salt.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = base64ToBytes(saltB64);

  // Derive a 256-bit AES key from the master password.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
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
      const key = makeSecretKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const plaintext = new TextEncoder().encode(value);
      const aad = makeAad(owner, name);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        plaintext,
      );

      // Pack IV || ciphertext (ciphertext includes the 16-byte GCM tag).
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(key, bytesToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = makeSecretKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      const combined = base64ToBytes(stored);
      if (combined.length < IV_LENGTH + 16) {
        throw new Error("Corrupt secret data: insufficient length");
      }

      const iv = combined.slice(0, IV_LENGTH);
      const ciphertext = combined.slice(IV_LENGTH);
      const aad = makeAad(owner, name);

      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          aesKey,
          ciphertext,
        );
      } catch {
        throw new Error("Tampered or invalid secret data");
      }

      return new TextDecoder().decode(plaintext);
    },

    async list(owner: string): Promise<string[]> {
      const prefix = SECRET_PREFIX + encodeKeyPart(owner) + ":";
      const allKeys = await storage.keys();
      const names: string[] = [];

      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const encodedName = k.slice(prefix.length);
          names.push(decodeKeyPart(encodedName));
        }
      }

      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = makeSecretKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
