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
 * Production-quality SecretStore implementation.
 * 
 * Security Design:
 * 1. Key Derivation: Uses PBKDF2 with a stored random salt to derive a 256-bit AES key.
 * 2. Encryption: Uses AES-GCM for authenticated encryption (confidentiality + integrity).
 * 3. Tamper Detection: AES-GCM authentication tags detect any modification to the ciphertext or IV.
 * 4. Owner Isolation: The owner ID and secret name are passed as Additional Authenticated Data (AAD).
 *    This binds the ciphertext to the specific owner/name, preventing "swap" attacks where 
 *    an attacker moves an encrypted blob from one secret slot to another.
 * 5. Storage: All binary data (IVs, salts, ciphertexts) is Base64 encoded for string-based KV storage.
 */
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // --- Helpers for Base64 binary handling (since we cannot import external libraries) ---
  const toB64 = (buf: Uint8Array): string => btoa(String.fromCharCode(...buf));
  const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // --- Key Management ---
  const SALT_KEY = "__system_salt__";
  const PBKDF2_ITERATIONS = 100_000;

  // Retrieve or create the master salt
  let saltB64 = await storage.get(SALT_KEY);
  if (!saltB64) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = fromB64(saltB64!);

  // Derive the AES-GCM key from the master password
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
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /**
   * Maps owner and name to a unique storage key.
   * Base64 encoding ensures that characters like ':', '/', or newlines in 
   * owners/names do not collide or break the prefix logic used in list().
   */
  const getStorageKey = (owner: string, name: string): string => {
    return `secret:${toB64(encoder.encode(owner))}:${toB64(encoder.encode(name))}`;
  };

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = encoder.encode(owner + "\x00" + name);
      
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: aad,
        },
        cryptoKey,
        encoder.encode(value),
      );

      // Store IV + Ciphertext as a single Base64 string
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);
      
      await storage.set(getStorageKey(owner, name), toB64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const dataB64 = await storage.get(getStorageKey(owner, name));
      if (dataB64 === undefined) return undefined;

      const combined = fromB64(dataB64);
      if (combined.length < 12) throw new Error("Stored data is corrupted");

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = encoder.encode(owner + "\x00" + name);

      try {
        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv,
            additionalData: aad,
          },
          cryptoKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch (e) {
        // AES-GCM throws an OperationError if the tag doesn't match (tampering or wrong password)
        throw new Error("Secret decryption failed: data is tampered with or incorrect password");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = `secret:${toB64(encoder.encode(owner))}:`;
      const allKeys = await storage.keys();
      
      const names: string[] = [];
      for (const key of allKeys) {
        if (key.startsWith(prefix)) {
          const parts = key.split(":");
          // The name is the 3rd part of the key: "secret:B64Owner:B64Name"
          const nameB64 = parts[2];
          names.push(decoder.decode(fromB64(nameB64)));
        }
      }

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = getStorageKey(owner, name);
      const exists = await storage.get(key);
      if (exists === undefined) {
        return false;
      }
      await storage.delete(key);
      return true;
    },
  };
}

