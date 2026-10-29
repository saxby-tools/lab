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

export function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  return build(options);
}

async function build(options: SecretStoreOptions): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Derive a 256-bit AES-GCM key deterministically from the master password.
  // A fixed salt is embedded in the module so the same password always yields
  // the same key without needing to read untrusted storage.
  const fixedSalt = enc.encode("secret-store-v1-fixed-salt");
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fixedSalt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Storage key layout: "secret:<enc-owner>:<enc-name>"
  // encodeURIComponent guarantees ':' never appears in the encoded segment,
  // so the two literal ':' separators are unambiguous.
  function storageKey(owner: string, name: string): string {
    return `secret:${encodeURIComponent(owner)}:${encodeURIComponent(name)}`;
  }

  function ownerPrefix(owner: string): string {
    return `secret:${encodeURIComponent(owner)}:`;
  }

  // --- base64 helpers (loop-based to avoid stack overflow on large data) ---
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // --- SecretStore implementation ---

  async function put(
    owner: string,
    name: string,
    value: string,
  ): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // Bind the ciphertext to its storage location via AAD so that copying
    // one secret's blob onto another's key will fail authentication.
    const aad = enc.encode(storageKey(owner, name));
    const plaintext = enc.encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plaintext,
    );

    // Layout: [12-byte IV][ciphertext || 16-byte GCM tag]
    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), 12);

    await storage.set(storageKey(owner, name), bytesToBase64(combined));
  }

  async function get(
    owner: string,
    name: string,
  ): Promise<string | undefined> {
    const k = storageKey(owner, name);
    const stored = await storage.get(k);
    if (stored === undefined) return undefined;

    // Decode and validate the stored blob
    let combined: Uint8Array;
    try {
      combined = base64ToBytes(stored);
    } catch {
      throw new Error("Corrupted secret data");
    }

    // Minimum: 12 (IV) + 16 (GCM tag) = 28 bytes
    if (combined.length < 28) {
      throw new Error("Corrupted secret data");
    }

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const aad = enc.encode(k);

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        ciphertext,
      );
      return dec.decode(plaintext);
    } catch {
      throw new Error("Failed to decrypt secret: possible tampering");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = ownerPrefix(owner);
    const allKeys = await storage.keys();
    const names: string[] = [];

    for (const k of allKeys) {
      if (k.startsWith(prefix)) {
        const encodedName = k.slice(prefix.length);
        try {
          names.push(decodeURIComponent(encodedName));
        } catch {
          // Skip keys with malformed name segments (tampered storage)
        }
      }
    }

    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const k = storageKey(owner, name);
    const existing = await storage.get(k);
    if (existing === undefined) return false;
    await storage.delete(k);
    return true;
  }

  return { put, get, list, remove };
}
