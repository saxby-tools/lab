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
 * Helper utilities for binary data conversion without external imports.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

function fromB64(base64: string): Uint8Array {
  const binary = atob(base64);
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

  // 1. Handle Salt Retrieval or Generation
  let saltB64 = await storage.get("__salt__");
  let salt: Uint8Array;

  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toB64(salt);
    await storage.set("__salt__", saltB64);
  } else {
    salt = fromB64(saltB64);
  }

  // 2. Derive Master Key using PBKDF2
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const cryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Password Verification
  // We store a known plaintext encrypted with the master key to ensure the password is correct.
  const verifyKey = "__verify__";
  const verifyValueB64 = await storage.get(verifyKey);
  const canaryText = "STORE_VERIFICATION_CANARY";

  if (verifyValueB64 === undefined) {
    // Initialize verification canary for new stores
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(verifyKey) },
      cryptoKey,
      encoder.encode(canaryText),
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    await storage.set(verifyKey, toB64(combined));
  } else {
    // Verify existing canary
    try {
      const data = fromB64(verifyValueB64);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(verifyKey) },
        cryptoKey,
        ciphertext,
      );
      if (decoder.decode(decrypted) !== canaryText) {
        throw new Error("Invalid master password");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // AAD ensures that the encrypted blob is bound to the specific owner and name.
      // This prevents an attacker from swapping one secret's ciphertext into another's slot.
      const aad = encoder.encode(`${owner}:${name}`);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        cryptoKey,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);

      const storageKey = `s:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
      await storage.set(storageKey, toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `s:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
      const storedB64 = await storage.get(storageKey);
      if (storedB64 === undefined) return undefined;

      try {
        const data = fromB64(storedB64);
        const iv = data.slice(0, 12);
        const ciphertext = data.slice(12);
        const aad = encoder.encode(`${owner}:${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          cryptoKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws if authentication fails (tampering detected)
        throw new Error("Secret tampering detected or invalid key");
      }
    },

    async list(owner: string): Promise<string[]> {
      const ownerB64 = toB64(encoder.encode(owner));
      const prefix = `s:${ownerB64}:`;
      const allKeys = await storage.keys();

      const ownerSecrets = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => {
          const parts = k.split(":");
          return decoder.decode(fromB64(parts[2]));
        });

      return ownerSecrets.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `s:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
