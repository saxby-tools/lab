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
 * Utility to handle Base64 encoding/decoding for Uint8Arrays and UTF-8 strings.
 * Uses global btoa/atob available in Deno.
 */
const Encoding = {
  toB64(bytes: Uint8Array): string {
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
  },
  fromB64(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  },
  strToB64(str: string): string {
    return this.toB64(new TextEncoder().encode(str));
  },
  b64ToStr(b64: string): string {
    return new TextDecoder().decode(this.fromB64(b64));
  }
};

class SecretStoreImpl implements SecretStore {
  private readonly encryptionKey: CryptoKey;
  private readonly storage: KeyValueStorage;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(storage: KeyValueStorage, encryptionKey: CryptoKey) {
    this.storage = storage;
    this.encryptionKey = encryptionKey;
  }

  private getStorageKey(owner: string, name: string): string {
    // Use Base64 to ensure owner/name delimiters don't collide with actual content
    return `sec:${Encoding.strToB64(owner)}:${Encoding.strToB64(name)}`;
  }

  private getAAD(owner: string, name: string): Uint8Array {
    // Domain separation: Ensure (owner="A", name="B") != (owner="AB", name="")
    return this.encoder.encode(`${owner}\x00${name}`);
  }

  async put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = this.encoder.encode(value);
    const aad = this.getAAD(owner, name);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      this.encryptionKey,
      plaintext
    );

    // Store IV concatenated with ciphertext
    const blob = new Uint8Array(iv.length + ciphertext.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ciphertext), iv.length);

    await this.storage.set(this.getStorageKey(owner, name), Encoding.toB64(blob));
  }

  async get(owner: string, name: string): Promise<string | undefined> {
    const storedB64 = await this.storage.get(this.getStorageKey(owner, name));
    if (!storedB64) return undefined;

    try {
      const blob = Encoding.fromB64(storedB64);
      if (blob.length < 12) throw new Error('Invalid data');

      const iv = blob.slice(0, 12);
      const ciphertext = blob.slice(12);
      const aad = this.getAAD(owner, name);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        this.encryptionKey,
        ciphertext
      );

      return this.decoder.decode(decrypted);
    } catch (e) {
      // AES-GCM throws if authentication tag fails or AAD is incorrect.
      // This satisfies the "tampering is detected" requirement.
      throw new Error('Secret decryption failed: data may be corrupted or tampered with');
    }
  }

  async list(owner: string): Promise<string[]> {
    const allKeys = await this.storage.keys();
    const ownerPrefix = `sec:${Encoding.strToB64(owner)}:`;
    
    const names = allKeys
      .filter(k => k.startsWith(ownerPrefix))
      .map(k => {
        const b64Name = k.substring(ownerPrefix.length);
        return Encoding.b64ToStr(b64Name);
      });

    return names.sort();
  }

  async remove(owner: string, name: string): Promise<boolean> {
    const key = this.getStorageKey(owner, name);
    const exists = await this.storage.get(key);
    if (!exists) return false;

    await this.storage.delete(key);
    return true;
  }
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const passwordBytes = new TextEncoder().encode(masterPassword);

  // 1. Derive a base key from the password for PBKDF2
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // 2. Handle Salt management
  const storedSaltB64 = await storage.get('__salt__');
  let salt: Uint8Array;

  if (!storedSaltB64) {
    // New store initialization
    salt = crypto.getRandomValues(new Uint8Array(16));
    await storage.set('__salt__', Encoding.toB64(salt));
  } else {
    salt = Encoding.fromB64(storedSaltB64);
  }

  // 3. Derive the actual AES-GCM key
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  // 4. Password Verification (Checksum)
  const checksumKey = '__checksum__';
  const storedChecksumB64 = await storage.get(checksumKey);
  const canaryValue = 'VERIFIED';

  if (!storedChecksumB64) {
    // Create checksum for first-time setup
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      new TextEncoder().encode(canaryValue)
    );
    const blob = new Uint8Array(iv.length + encrypted.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(encrypted), iv.length);
    await storage.set(checksumKey, Encoding.toB64(blob));
  } else {
    // Verify password by decrypting the checksum
    try {
      const blob = Encoding.fromB64(storedChecksumB64);
      const iv = blob.slice(0, 12);
      const ciphertext = blob.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        ciphertext
      );
      if (new TextDecoder().decode(decrypted) !== canaryValue) {
        throw new Error('Invalid master password');
      }
    } catch (e) {
      throw new Error('Invalid master password');
    }
  }

  return new SecretStoreImpl(storage, encryptionKey);
}
