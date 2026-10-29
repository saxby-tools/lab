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
 * Helper to convert Uint8Array to Base64 string.
 * Since we cannot import Buffer or other utilities, we use the global btoa.
 */
function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Helper to convert Base64 string to Uint8Array.
 */
function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

class SecretStoreImpl implements SecretStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly masterKey: CryptoKey,
  ) {}

  /**
   * Encrypts a value using AES-GCM.
   * includes the owner and name in the Additional Authenticated Data (AAD) 
   * to prevent substitution attacks (copying one secret's data to another).
   */
  private async encrypt(owner: string, name: string, value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = this.encoder.encode(value);
    const aad = this.encoder.encode(owner + "\x00" + name);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      this.masterKey,
      plaintext,
    );

    // Store as IV + ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return toB64(combined);
  }

  /**
   * Decrypts a value. Throws if authentication fails.
   */
  private async decrypt(owner: string, name: string, encryptedB64: string): Promise<string> {
    const combined = fromB64(encryptedB64);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const aad = this.encoder.encode(owner + "\x00" + name);

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        this.masterKey,
        data,
      );
      return this.decoder.decode(decrypted);
    } catch (e) {
      throw new Error("Tampering detected or invalid key");
    }
  }

  private getStorageKey(owner: string, name: string): string {
    // Base64 encode owner and name to avoid collisions with the delimiter
    const ownerB64 = toB64(this.encoder.encode(owner));
    const nameB64 = toB64(this.encoder.encode(name));
    return `s:${ownerB64}:${nameB64}`;
  }

  async put(owner: string, name: string, value: string): Promise<void> {
    const encrypted = await this.encrypt(owner, name, value);
    await this.storage.set(this.getStorageKey(owner, name), encrypted);
  }

  async get(owner: string, name: string): Promise<string | undefined> {
    const encrypted = await this.storage.get(this.getStorageKey(owner, name));
    if (encrypted === undefined) return undefined;
    return await this.decrypt(owner, name, encrypted);
  }

  async list(owner: string): Promise<string[]> {
    const allKeys = await this.storage.keys();
    const ownerB64 = toB64(this.encoder.encode(owner));
    const prefix = `s:${ownerB64}:`;

    const names: string[] = [];
    for (const key of allKeys) {
      if (key.startsWith(prefix)) {
        const nameB64 = key.substring(prefix.length);
        names.push(this.decoder.decode(fromB64(nameB64)));
      }
    }

    return names.sort();
  }

  async remove(owner: string, name: string): Promise<boolean> {
    const key = this.getStorageKey(owner, name);
    const exists = await this.storage.get(key);
    if (exists === undefined) return false;

    await this.storage.delete(key);
    return true;
  }
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  // 1. Handle Salt
  let saltB64 = await storage.get("__salt__");
  let salt: Uint8Array;
  if (saltB64) {
    salt = fromB64(saltB64);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set("__salt__", toB64(salt));
  }

  // 2. Derive Master Key using PBKDF2
  const passwordBytes = encoder.encode(masterPassword);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
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
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Verify Master Password via a Canary
  const verifierKey = "__verifier__";
  const verifierValue = await storage.get(verifierKey);

  if (verifierValue) {
    // Existing store: attempt to decrypt the canary to verify password
    const combined = fromB64(verifierValue);
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const aad = encoder.encode("verifier");

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        masterKey,
        data,
      );
      if (encoder.decode(decrypted) !== "verified") {
        throw new Error();
      }
    } catch {
      throw new Error("Invalid master password");
    }
  } else {
    // New store: create the canary
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode("verified");
    const aad = encoder.encode("verifier");

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      masterKey,
      plaintext,
    );

    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    await storage.set(verifierKey, toB64(combined));
  }

  return new SecretStoreImpl(storage, masterKey);
}
