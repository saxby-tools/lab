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

  const SALT_KEY = "secretstore:v1:salt";
  const SECRET_PREFIX = "secretstore:v1:secret:";
  const PBKDF2_ITERATIONS = 100_000;

  // --- Salt: create on first use, reuse thereafter ---
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    saltB64 = b64Encode(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = b64Decode(saltB64);

  // --- Derive a 256-bit AES-GCM key from the master password ---
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- Helpers ---

  function storageKey(owner: string, name: string): string {
    const o = b64Encode(new TextEncoder().encode(owner));
    const n = b64Encode(new TextEncoder().encode(name));
    return `${SECRET_PREFIX}${o}:${n}`;
  }

  function ownerPrefix(owner: string): string {
    const o = b64Encode(new TextEncoder().encode(owner));
    return `${SECRET_PREFIX}${o}:`;
  }

  // --- Public API ---

  async function put(
    owner: string,
    name: string,
    value: string,
  ): Promise<void> {
    const key = storageKey(owner, name);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(value);
    // Bind the ciphertext to its storage key so that copying the blob
    // to a different owner/name will fail GCM authentication.
    const aad = new TextEncoder().encode(key);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      encryptionKey,
      plaintext,
    );

    const blob = JSON.stringify({
      iv: b64Encode(iv),
      ct: b64Encode(new Uint8Array(ciphertext)),
    });
    await storage.set(key, blob);
  }

  async function get(
    owner: string,
    name: string,
  ): Promise<string | undefined> {
    const key = storageKey(owner, name);
    const raw = await storage.get(key);
    if (raw === undefined) return undefined;

    let record: { iv?: unknown; ct?: unknown };
    try {
      record = JSON.parse(raw) as { iv?: unknown; ct?: unknown };
    } catch {
      throw new Error("Corrupted secret: invalid JSON");
    }

    if (typeof record.iv !== "string" || typeof record.ct !== "string") {
      throw new Error("Corrupted secret: invalid record structure");
    }

    let ivBytes: Uint8Array;
    let ctBytes: Uint8Array;
    try {
      ivBytes = b64Decode(record.iv);
      ctBytes = b64Decode(record.ct);
    } catch {
      throw new Error("Corrupted secret: invalid base64 encoding");
    }

    const aad = new TextEncoder().encode(key);

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: ivBytes, additionalData: aad },
        encryptionKey,
        ctBytes,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new Error(
        "Decryption failed: secret may be tampered with or the password is incorrect",
      );
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = ownerPrefix(owner);
    const allKeys = await storage.keys();

    const names: string[] = [];
    for (const key of allKeys) {
      if (key.startsWith(prefix)) {
        const nameB64 = key.slice(prefix.length);
        try {
          const name = new TextDecoder().decode(b64Decode(nameB64));
          names.push(name);
        } catch {
          // Skip entries that do not decode to a valid name.
        }
      }
    }

    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = storageKey(owner, name);
    const existing = await storage.get(key);
    if (existing === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}

// --- base64 helpers (Uint8Array ↔ string, UTF-8 safe) ---

function b64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function b64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
