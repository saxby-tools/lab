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

  const SALT_KEY = "\x00__secret_store_salt__";
  const SECRET_PREFIX = "\x00__secret_store_secret__\x00";

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // --- Base64 helpers (avoids spread-operator stack overflow on large buffers) ---
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  // --- Derive the encryption key from the master password ---
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    saltB64 = bytesToBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }

  const salt = base64ToBytes(saltB64);

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- Storage key construction ---
  function secretKeyFor(owner: string, name: string): string {
    return SECRET_PREFIX + JSON.stringify([owner, name]);
  }

  // --- Encrypt / Decrypt with AES-256-GCM + AAD bound to the storage key ---
  async function encrypt(plaintext: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = enc.encode(plaintext);
    const aadBytes = enc.encode(aad);
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadBytes },
      aesKey,
      data,
    );
    const ciphertext = new Uint8Array(ciphertextBuf);
    const combined = new Uint8Array(12 + ciphertext.length);
    combined.set(iv, 0);
    combined.set(ciphertext, 12);
    return bytesToBase64(combined);
  }

  async function decrypt(stored: string, aad: string): Promise<string> {
    const combined = base64ToBytes(stored);
    if (combined.length < 28) {
      throw new Error("Ciphertext too short");
    }
    const iv = combined.subarray(0, 12);
    const ciphertext = combined.subarray(12);
    const aadBytes = enc.encode(aad);
    const plaintextBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aadBytes },
      aesKey,
      ciphertext,
    );
    return dec.decode(plaintextBuf);
  }

  // --- Public API ---
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = secretKeyFor(owner, name);
      const encrypted = await encrypt(value, key);
      await storage.set(key, encrypted);
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = secretKeyFor(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) {
        return undefined;
      }
      try {
        return await decrypt(stored, key);
      } catch {
        throw new Error(
          "Failed to decrypt secret: data may have been tampered with or the password is incorrect",
        );
      }
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (!k.startsWith(SECRET_PREFIX)) continue;
        try {
          const json = k.slice(SECRET_PREFIX.length);
          const parsed: unknown = JSON.parse(json);
          if (
            Array.isArray(parsed) &&
            parsed.length === 2 &&
            typeof parsed[0] === "string" &&
            typeof parsed[1] === "string" &&
            parsed[0] === owner
          ) {
            names.push(parsed[1]);
          }
        } catch {
          // Skip unparseable or malformed keys
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = secretKeyFor(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) {
        return false;
      }
      await storage.delete(key);
      return true;
    },
  };
}
