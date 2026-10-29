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
 * Helper for binary-to-base64 conversion without importing external libraries.
 */
function bufToBase64(buf: Uint8Array): string {
  return btoa(Array.from(buf, b => String.fromCharCode(b)).join(''));
}

/**
 * Helper for base64-to-binary conversion.
 */
function base64ToBuf(str: string): Uint8Array {
  const binary = atob(str);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // 1. Handle Salt Management
  const saltKey = "_system_salt";
  const verifyKey = "_system_verify";
  let saltBuf = await storage.get(saltKey);

  if (saltBuf === undefined) {
    // First time initialization: create salt and canary
    saltBuf = crypto.getRandomValues(new Uint8Array(16));
    await storage.set(saltKey, bufToBase64(saltBuf));
  } else {
    saltBuf = base64ToBuf(saltBuf);
  }

  // 2. Key Derivation using PBKDF2
  // We derive a 256-bit AES-GCM key from the master password
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBuf,
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Verify Master Password via Canary
  const canaryText = "SECRET_STORE_VERIFICATION_CANARY";
  const storedCanary = await storage.get(verifyKey);

  if (storedCanary === undefined) {
    // Create the canary for future verification
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedCanary = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      encoder.encode(canaryText),
    );
    const combined = new Uint8Array(iv.length + encryptedCanary.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encryptedCanary), iv.length);
    await storage.set(verifyKey, bufToBase64(combined));
  } else {
    // Validate the existing canary
    try {
      const data = base64ToBuf(storedCanary);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        ciphertext,
      );
      if (decoder.decode(decrypted) !== canaryText) {
        throw new Error("Master password verification failed");
      }
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  // Implementation of the SecretStore interface
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // AAD (Additional Authenticated Data) prevents moving secrets between owners/names
      const aad = encoder.encode(`${owner}::${name}`);
      
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        encoder.encode(value),
      );

      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);

      // Use btoa to ensure key safety regardless of input characters
      const storageKey = `s:${btoa(owner)}:${btoa(name)}`;
      await storage.set(storageKey, bufToBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `s:${btoa(owner)}:${btoa(name)}`;
      const encryptedBase64 = await storage.get(storageKey);
      if (encryptedBase64 === undefined) return undefined;

      const data = base64ToBuf(encryptedBase64);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const aad = encoder.encode(`${owner}::${name}`);

      try {
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          aesKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // Tampering is detected if decryption fails (tag mismatch)
        throw new Error("Secret data is corrupted or tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `s:${btoa(owner)}:`;
      
      const names = allKeys
        .filter(k => k.startsWith(prefix))
        .map(k => {
          const encodedName = k.slice(prefix.length);
          return atob(encodedName);
        });

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `s:${btoa(owner)}:${btoa(name)}`;
      const exists = await storage.get(storageKey);
      if (exists === undefined) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
