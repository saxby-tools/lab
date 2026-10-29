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
 * Implementation of the SecretStore.
 * Uses AES-GCM for authenticated encryption to ensure confidentiality and integrity.
 * PBKDF2 is used for key derivation from the master password.
 */
class SecretStoreImpl implements SecretStore {
  private readonly key: CryptoKey;
  private readonly storage: KeyValueStorage;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(storage: KeyValueStorage, key: CryptoKey) {
    this.storage = storage;
    this.key = key;
  }

  private getSecretKey(owner: string, name: string): string {
    // We base64 encode owner and name to ensure the KV keys are unique and 
    // delimiter-safe, regardless of characters in the owner/name strings.
    const ownerB64 = btoa(owner);
    const nameB64 = btoa(name);
    return `sec:${ownerB64}:${nameB64}`;
  }

  private getAAD(owner: string, name: string): Uint8Array {
    // Additional Authenticated Data (AAD) binds the ciphertext to the specific 
    // owner and secret name. This prevents an attacker from moving a valid 
    // encrypted blob from one secret slot to another.
    return this.encoder.encode(`${owner}||${name}`);
  }

  async put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plainText = this.encoder.encode(value);
    const aad = this.getAAD(owner, name);

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      this.key,
      plainText
    );

    // Store IV and Ciphertext together
    const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuffer), iv.length);

    const storageValue = btoa(String.fromCharCode(...combined));
    await this.storage.set(this.getSecretKey(owner, name), storageValue);
  }

  async get(owner: string, name: string): Promise<string | undefined> {
    const storedValue = await this.storage.get(this.getSecretKey(owner, name));
    if (storedValue === undefined) return undefined;

    try {
      const combined = Uint8Array.from(atob(storedValue), (c) => c.charCodeAt(0));
      if (combined.length < 28) throw new Error("Invalid stored data"); // 12 (IV) + 16 (Tag)

      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      const aad = this.getAAD(owner, name);

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        this.key,
        data
      );

      return this.decoder.decode(decrypted);
    } catch (e) {
      // Tamper detection: Any modification to the ciphertext, IV, or AAD 
      // (including moving the secret to a different owner/name) triggers a failure.
      throw new Error("Secret decryption failed: Data may have been tampered with or corrupted.");
    }
  }

  async list(owner: string): Promise<string[]> {
    const allKeys = await this.storage.keys();
    const ownerB64 = btoa(owner);
    const prefix = `sec:${ownerB64}:`;

    const names: string[] = [];
    for (const key of allKeys) {
      if (key.startsWith(prefix)) {
        const parts = key.split(":");
        // The key is sec:ownerB64:nameB64
        names.push(atob(parts[2]));
      }
    }

    return names.sort();
  }

  async remove(owner: string, name: string): Promise<boolean> {
    const key = this.getSecretKey(owner, name);
    const exists = await this.storage.get(key) !== undefined;
    if (exists) {
      await this.storage.delete(key);
    }
    return exists;
  }
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const encoder = new TextEncoder();

  const SALT_KEY = "__master_salt__";
  const CANARY_KEY = "__canary__";

  // 1. Retrieve or initialize the salt
  let saltString = await storage.get(SALT_KEY);
  let isFirstRun = false;

  if (saltString === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltString = btoa(String.fromCharCode(...salt));
    await storage.set(SALT_KEY, saltString);
    isFirstRun = true;
  }

  const salt = Uint8Array.from(atob(saltString), (c) => c.charCodeAt(0));

  // 2. Derive the encryption key from the master password
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const cryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // 3. Verify password correctness using a canary value
  const canaryData = await storage.get(CANARY_KEY);
  if (isFirstRun || canaryData === undefined) {
    // Create a canary to validate password in the future
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const canaryText = encoder.encode("CANARY_VALIDATION_STRING");
    const encryptedCanary = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      canaryText,
    );
    const combined = new Uint8Array(iv.length + encryptedCanary.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encryptedCanary), iv.length);
    await storage.set(CANARY_KEY, btoa(String.fromCharCode(...combined)));
  } else {
    // Try to decrypt existing canary to verify masterPassword
    try {
      const combined = Uint8Array.from(atob(canaryData), (c) => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const data = combined.slice(12);
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, data);
    } catch (e) {
      throw new Error("Invalid master password");
    }
  }

  return new SecretStoreImpl(storage, cryptoKey);
}

