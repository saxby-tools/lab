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

  // Helpers for Base64 <-> Uint8Array conversion for binary data in storage
  const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const fromB64 = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  // UTF-8 safe Base64 for keys
  const toSafeB64 = (str: string) => toB64(encoder.encode(str));
  const fromSafeB64 = (b64: string) => decoder.decode(fromB64(b64));

  const SALT_KEY = "__master_salt__";
  const PBKDF2_ITERATIONS = 100000;
  const AES_ALGO = "AES-GCM";

  // 1. Handle Master Salt
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = fromB64(saltB64);

  // 2. Derive Master Key from Password
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
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: AES_ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // Use owner and name as Additional Authenticated Data (AAD) to prevent 
      // "copy-paste" attacks where one secret's ciphertext is moved to another key.
      const aad = encoder.encode(owner + "\x00" + name);
      const plaintext = encoder.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        {
          name: AES_ALGO,
          iv,
          additionalData: aad,
        },
        masterKey,
        plaintext,
      );

      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);

      const storageKey = `sec:${toSafeB64(owner)}:${toSafeB64(name)}`;
      await storage.set(storageKey, toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `sec:${toSafeB64(owner)}:${toSafeB64(name)}`;
      const encryptedB64 = await storage.get(storageKey);
      if (encryptedB64 === undefined) return undefined;

      try {
        const combined = fromB64(encryptedB64);
        if (combined.length < 28) throw new Error("Invalid data length"); // 12(IV) + 16(Tag)

        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const aad = encoder.encode(owner + "\x00" + name);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: AES_ALGO,
            iv,
            additionalData: aad,
          },
          masterKey,
          ciphertext,
        );

        return decoder.decode(decrypted);
      } catch (e) {
        // Tampering detection: throw Error if decryption/integrity check fails
        throw new Error("Secret data is corrupted or has been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const ownerB64 = toSafeB64(owner);
      const prefix = `sec:${ownerB64}:`;
      const allKeys = await storage.keys();

      const secrets = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => {
          const nameB64 = k.slice(prefix.length);
          return fromSafeB64(nameB64);
        });

      return secrets.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `sec:${toSafeB64(owner)}:${toSafeB64(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}

