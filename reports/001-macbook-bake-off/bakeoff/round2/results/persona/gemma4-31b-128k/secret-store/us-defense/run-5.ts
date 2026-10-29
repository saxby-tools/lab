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
 * Senior Web Developer implementation of a Secure Secret Store.
 * 
 * Security Design:
 * 1. Key Derivation: PBKDF2-HMAC-SHA256 is used to derive a 256-bit AES key from the master password.
 * 2. Encryption: AES-GCM provides authenticated encryption, ensuring both confidentiality and integrity.
 * 3. Isolation: The 'owner' and 'name' are passed as Additional Authenticated Data (AAD) to the 
 *    AES-GCM cipher. This prevents "substitution attacks" where an attacker moves an encrypted 
 *    blob from one secret slot to another.
 * 4. Tamper Detection: AES-GCM's authentication tag ensures that any modification to the 
 *    ciphertext or AAD results in a decryption failure.
 * 5. Master Password Validation: A "canary" value is encrypted and stored. If the derived 
 *    key cannot decrypt the canary, the password is incorrect.
 */
export async function createSecretStore(options: SecretStoreOptions): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Helper: Convert bytes to Base64 string without using external imports
  const toB64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  // Helper: Convert Base64 string to bytes
  const fromB64 = (b64: string): Uint8Array => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // --- Key Derivation Logic ---
  const SALT_KEY = "sys:salt";
  const CANARY_KEY = "sys:canary";
  const ITERATIONS = 100_000;

  let saltBytes = await storage.get(SALT_KEY);
  let encryptionKey: CryptoKey;

  if (!saltBytes) {
    // Initialize new store
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(SALT_KEY, toB64(salt));
    saltBytes = toB64(salt);
  }

  const salt = fromB64(saltBytes);
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- Password Verification (Canary) ---
  const canaryValue = "STORE_VERIFICATION_CANARY";
  const existingCanary = await storage.get(CANARY_KEY);

  if (!existingCanary) {
    // First time setup: create canary
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode("canary") },
      encryptionKey,
      encoder.encode(canaryValue),
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    await storage.set(CANARY_KEY, toB64(combined));
  } else {
    // Validate existing store
    try {
      const combined = fromB64(existingCanary);
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode("canary") },
        encryptionKey,
        data,
      );
      if (decoder.decode(decrypted) !== canaryValue) throw new Error();
    } catch (e) {
      throw new Error("Invalid master password or corrupted store.");
    }
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(`${owner}\0${name}`);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        encryptionKey,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      
      // Key format: secret:{b64_owner}:{b64_name} to handle arbitrary chars in owner/name
      const storageKey = `secret:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
      await storage.set(storageKey, toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `secret:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
      const encryptedB64 = await storage.get(storageKey);
      if (!encryptedB64) return undefined;

      try {
        const combined = fromB64(encryptedB64);
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);
        const aad = encoder.encode(`${owner}\0${name}`);

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          encryptionKey,
          data,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // GCM decryption fails if the tag is invalid or AAD doesn't match
        throw new Error("Secret tampering detected or decryption failed.");
      }
    },

    async list(owner: string): Promise<string[]> {
      const ownerB64 = toB64(encoder.encode(owner));
      const prefix = `secret:${ownerB64}:`;
      const allKeys = await storage.keys();
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          // The last part is the base64 encoded name
          const nameB64 = parts[parts.length - 1];
          names.push(decoder.decode(fromB64(nameB64)));
        }
      }
      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `secret:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
      const existing = await storage.get(storageKey);
      if (existing === undefined) return false;
      
      await storage.delete(storageKey);
      return true;
    },
  };
}
