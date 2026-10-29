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
 * Helper to convert UTF-8 strings to Base64.
 * Necessary because btoa/atob handle Latin1 by default.
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary);
}

/**
 * Helper to convert Base64 strings back to UTF-8.
 */
function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // 1. Salt Management
  // We store a master salt in the storage to derive the key from the masterPassword.
  let saltB64 = await storage.get("__salt");
  if (!saltB64) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = btoa(String.fromCharCode(...salt));
    await storage.set("__salt", saltB64);
  }
  const salt = Uint8Array.from(atob(saltB64!), (c) => c.charCodeAt(0));

  // 2. Key Derivation
  // Use PBKDF2 to derive a strong 256-bit AES-GCM key from the master password and salt.
  const encoder = new TextEncoder();
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
      iterations: 100000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const storageKey = `s:${utf8ToBase64(owner)}:${utf8ToBase64(name)}`;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plainText = encoder.encode(value);

      // To prevent "copy-paste" attacks (where an attacker moves an encrypted blob
      // from one secret to another), we include the storage key as Additional 
      // Authenticated Data (AAD).
      const encrypted = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(storageKey),
        },
        masterKey,
        plainText,
      );

      // Store IV and ciphertext together.
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);
      
      const b64Value = btoa(String.fromCharCode(...combined));
      await storage.set(storageKey, b64Value);
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const storageKey = `s:${utf8ToBase64(owner)}:${utf8ToBase64(name)}`;
      const b64Value = await storage.get(storageKey);
      if (!b64Value) return undefined;

      try {
        const combined = Uint8Array.from(atob(b64Value), (c) => c.charCodeAt(0));
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);

        const decrypted = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: encoder.encode(storageKey),
          },
          masterKey,
          ciphertext,
        );

        return new TextDecoder().decode(decrypted);
      } catch (e) {
        // AES-GCM throws an OperationError if the authentication tag is invalid.
        // This satisfies the requirement to throw an Error if tampering is detected.
        throw new Error("Secret corrupted or tampering detected");
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const ownerPrefix = `s:${utf8ToBase64(owner)}:`;
      
      const names = allKeys
        .filter((k) => k.startsWith(ownerPrefix))
        .map((k) => {
          const b64Name = k.substring(ownerPrefix.length);
          return base64ToUtf8(b64Name);
        });

      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const storageKey = `s:${utf8ToBase64(owner)}:${utf8ToBase64(name)}`;
      const exists = await storage.get(storageKey);
      if (!exists) return false;

      await storage.delete(storageKey);
      return true;
    },
  };
}
