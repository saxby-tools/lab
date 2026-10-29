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

  // Binary helpers since we can't import Buffer
  const binToBase64 = (buf: Uint8Array) => btoa(String.fromCharCode(...buf));
  const base64ToBin = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  // 1. Key Derivation
  // We need a salt to derive a strong key from the password
  let saltBase64 = await storage.get("system:salt");
  let salt: Uint8Array;

  if (saltBase64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set("system:salt", binToBase64(salt));
  } else {
    salt = base64ToBin(saltBase64);
  }

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
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 2. Password Validation
  // We encrypt a canary value to ensure the master password is correct
  const VALIDATION_KEY = "system:validation";
  const CANARY_TEXT = "secret-store-validation-canary";
  const validationBlob = await storage.get(VALIDATION_KEY);

  if (validationBlob === undefined) {
    // First time setup: create the validation canary
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(VALIDATION_KEY) },
      masterKey,
      encoder.encode(CANARY_TEXT),
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    await storage.set(VALIDATION_KEY, binToBase64(combined));
  } else {
    // Existing store: verify canary
    try {
      const combined = base64ToBin(validationBlob);
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(VALIDATION_KEY) },
        masterKey,
        data,
      );
      if (decoder.decode(decrypted) !== CANARY_TEXT) {
        throw new Error("Invalid master password");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  // 3. Store Implementation
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // We use AAD (Additional Authenticated Data) to bind the encrypted value 
      // to the specific owner and name. This prevents an attacker from 
      // copying a ciphertext from one secret slot to another.
      const aad = encoder.encode(`${owner}\0${name}`);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        masterKey,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);

      // We encode owner/name to base64 to avoid delimiter collisions in the KV keys
      const storageKey = `secret:${binToBase64(encoder.encode(owner))}:${binToBase64(encoder.encode(name))}`;
      await storage.set(storageKey, binToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secret:${binToBase64(encoder.encode(owner))}:${binToBase64(encoder.encode(name))}`;
      const blob = await storage.get(storageKey);
      if (blob === undefined) return undefined;

      try {
        const combined = base64ToBin(blob);
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);
        const aad = encoder.encode(`${owner}\0${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          masterKey,
          data,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // Tampering detection: if the tag is invalid or AAD doesn't match, GCM throws.
        throw new Error("Secret data has been tampered with or is corrupted");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `secret:${binToBase64(encoder.encode(owner))}:`;
      const names: string[] = [];

      for (const key of allKeys) {
        if (key.startsWith(ownerPrefix)) {
          const parts = key.split(":");
          const nameB64 = parts[parts.length - 1];
          names.push(decoder.decode(base64ToBin(nameB64)));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secret:${binToBase64(encoder.encode(owner))}:${binToBase64(encoder.encode(name))}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
