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
 * Helper to convert Uint8Array to a base64 string using Web APIs.
 */
function toBase64(buf: Uint8Array): string {
  let binary = "";
  const len = buf.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

/**
 * Helper to convert a base64 string to a Uint8Array using Web APIs.
 */
function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

class SecretStoreImpl implements SecretStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly encryptionKey: CryptoKey;

  constructor(
    private readonly storage: KeyValueStorage,
    encryptionKey: CryptoKey,
  ) {
    this.encryptionKey = encryptionKey;
  }

  private getStorageKey(owner: string, name: string): string {
    const ownerB64 = toBase64(this.encoder.encode(owner));
    const nameB64 = toBase64(this.encoder.encode(name));
    return `secret:${ownerB64}:${nameB64}`;
  }

  private getAAD(owner: string, name: string): Uint8Array {
    // AAD binds the ciphertext to the specific owner and secret name
    return this.encoder.encode(`${owner}::${name}`);
  }

  async put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = this.getAAD(owner, name);
    const data = this.encoder.encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      this.encryptionKey,
      data,
    );

    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    await this.storage.set(this.getStorageKey(owner, name), toBase64(combined));
  }

  async get(owner: string, name: string): Promise<string | undefined> {
    const key = this.getStorageKey(owner, name);
    const storedValue = await this.storage.get(key);

    if (storedValue === undefined) {
      return undefined;
    }

    try {
      const combined = fromBase64(storedValue);
      if (combined.length < 13) throw new Error("Invalid data length");

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = this.getAAD(owner, name);

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        this.encryptionKey,
        ciphertext,
      );

      return this.decoder.decode(decrypted);
    } catch (e) {
      // Tampering detected or wrong master password used to derive the key
      throw new Error("Secret decryption failed: data may be corrupted or tampered with");
    }
  }

  async list(owner: string): Promise<string[]> {
    const ownerB64 = toBase64(this.encoder.encode(owner));
    const prefix = `secret:${ownerB64}:`;
    const allKeys = await this.storage.keys();

    const names = allKeys
      .filter((k) => k.startsWith(prefix))
      .map((k) => {
        const nameB64 = k.substring(prefix.length);
        return this.decoder.decode(fromBase64(nameB64));
      });

    return names.sort();
  }

  async remove(owner: string, name: string): Promise<boolean> {
    const key = this.getStorageKey(owner, name);
    const exists = await this.storage.get(key) !== undefined;
    if (exists) {
      await this.storage.delete(key);
      return true;
    }
    return false;
  }
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  // 1. Retrieve or create salt for key derivation
  let saltB64 = await storage.get("system:salt");
  let salt: Uint8Array;

  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set("system:salt", toBase64(salt));
  } else {
    salt = fromBase64(saltB64);
  }

  // 2. Derive the master encryption key using PBKDF2
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Verify master password using a canary value
  const verifyKey = "system:verify";
  const storedVerifyB64 = await storage.get(verifyKey);

  if (storedVerifyB64 === undefined) {
    // First time setup: create the canary
    const canaryValue = "verified";
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedCanary = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      derivedKey,
      encoder.encode(canaryValue),
    );
    const combined = new Uint8Array(iv.length + encryptedCanary.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encryptedCanary), iv.length);
    await storage.set(verifyKey, toBase64(combined));
  } else {
    // Existing store: validate the password
    try {
      const combined = fromBase64(storedVerifyB64);
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, derivedKey, ciphertext);
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return new SecretStoreImpl(storage, derivedKey);
}
