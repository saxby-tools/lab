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

  // Helper to convert binary to base64 and vice versa
  const binToB64 = (buf: Uint8Array): string => btoa(String.fromCharCode(...buf));
  const b64ToBin = (str: string): Uint8Array => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  // Helper to create a safe storage key for owner/name pairs
  const getStorageKey = (owner: string, name: string) => `sec:${binToB64(encoder.encode(owner))}:${binToB64(encoder.encode(name))}`;

  // 1. Handle Salt and Key Derivation
  let saltB64 = await storage.get("__salt__");
  let salt: Uint8Array;

  if (saltB64 === undefined) {
    // Initial setup: generate salt and store it
    salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = binToB64(salt);
    await storage.set("__salt__", saltB64);
  } else {
    salt = b64ToBin(saltB64);
  }

  // Derive the master key using PBKDF2
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 2. Verify Master Password (Canary check)
  const VERIFY_KEY = "__verify__";
  const VERIFY_TEXT = "SECRET_STORE_VERIFICATION_TOKEN";
  const verifyValue = await storage.get(VERIFY_KEY);

  if (verifyValue === undefined) {
    // Create the canary for future password verification
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode("verify") },
      encryptionKey,
      encoder.encode(VERIFY_TEXT),
    );
    const payload = new Uint8Array(iv.length + encrypted.byteLength);
    payload.set(iv);
    payload.set(new Uint8Array(encrypted), iv.length);
    await storage.set(VERIFY_KEY, binToB64(payload));
  } else {
    // Validate existing canary
    try {
      const data = b64ToBin(verifyValue);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode("verify") },
        encryptionKey,
        ciphertext,
      );
      if (decoder.decode(decrypted) !== VERIFY_TEXT) {
        throw new Error("Invalid master password");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // Bound the secret to the owner and name via Additional Authenticated Data (AAD)
      // This prevents an attacker from moving one secret's ciphertext to another's slot.
      const ad = encoder.encode(`${owner}:${name}`);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: ad },
        encryptionKey,
        encoder.encode(value),
      );

      const payload = new Uint8Array(iv.length + encrypted.byteLength);
      payload.set(iv);
      payload.set(new Uint8Array(encrypted), iv.length);

      await storage.set(getStorageKey(owner, name), binToB64(payload));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const encryptedB64 = await storage.get(getStorageKey(owner, name));
      if (encryptedB64 === undefined) return undefined;

      try {
        const data = b64ToBin(encryptedB64);
        if (data.length < 12) throw new Error("Malformed data");
        
        const iv = data.slice(0, 12);
        const ciphertext = data.slice(12);
        const ad = encoder.encode(`${owner}:${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: ad },
          encryptionKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // Any failure in decryption (wrong key or tampered data) throws Error per spec
        throw new Error("Secret tampering detected or decryption failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `sec:${binToB64(encoder.encode(owner))}:`;
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const nameB64 = key.slice(prefix.length);
          names.push(decoder.decode(b64ToBin(nameB64)));
        }
      }
      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key);
      if (exists === undefined) return false;

      await storage.delete(key);
      return true;
    },
  };
}
