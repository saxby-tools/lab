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

const SALT_KEY = "__secret_store_salt__";
const SECRET_PREFIX = "secret/";
const PBKDF2_ITERATIONS = 100_000;

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Retrieve or create the PBKDF2 salt stored in the backend.
  let saltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (saltB64 === undefined) {
    salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    saltB64 = bytesToBase64Url(salt);
    await storage.set(SALT_KEY, saltB64);
  } else {
    try {
      salt = base64UrlToBytes(saltB64);
    } catch {
      throw new Error("Invalid salt in storage");
    }
  }

  // Derive a 256-bit AES-GCM key from the master password.
  const pwdBytes = new TextEncoder().encode(masterPassword);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    pwdBytes,
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Build a storage key for a (owner, name) pair.
  // Uses base64url so the '/' separator is unambiguous.
  function storageKey(owner: string, name: string): string {
    const o = bytesToBase64Url(new TextEncoder().encode(owner));
    const n = bytesToBase64Url(new TextEncoder().encode(name));
    return `${SECRET_PREFIX}${o}/${n}`;
  }

  // Build the AAD that binds ciphertext to a specific (owner, name) pair.
  // Length-prefixed to avoid ambiguity with arbitrary bytes in the strings.
  function makeAad(owner: string, name: string): Uint8Array {
    const ob = new TextEncoder().encode(owner);
    const nb = new TextEncoder().encode(name);
    const aad = new Uint8Array(4 + ob.length + 4 + nb.length);
    const dv = new DataView(aad.buffer);
    dv.setUint32(0, ob.length, true);
    dv.setUint32(4 + ob.length, nb.length, true);
    aad.set(ob, 4);
    aad.set(nb, 8 + ob.length);
    return aad;
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const nonce = new Uint8Array(12);
      crypto.getRandomValues(nonce);

      const aad = makeAad(owner, name);
      const plaintext = new TextEncoder().encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", nonce, additionalData: aad },
        aesKey,
        plaintext,
      );

      // Wire format: nonce(12) || ciphertext+tag
      const ct = new Uint8Array(ciphertext);
      const combined = new Uint8Array(12 + ct.length);
      combined.set(nonce, 0);
      combined.set(ct, 12);

      const key = storageKey(owner, name);
      await storage.set(key, bytesToBase64Url(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = storageKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      let data: Uint8Array;
      try {
        data = base64UrlToBytes(stored);
      } catch {
        throw new Error("Tampered or invalid secret data");
      }

      if (data.length < 12) {
        throw new Error("Tampered or invalid secret data");
      }

      const nonce = data.slice(0, 12);
      const ct = data.slice(12);
      const aad = makeAad(owner, name);

      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", nonce, additionalData: aad },
          aesKey,
          ct,
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        throw new Error("Tampered or invalid secret data");
      }
    },

    async list(owner: string): Promise<string[]> {
      const ownerB64 = bytesToBase64Url(new TextEncoder().encode(owner));
      const prefix = `${SECRET_PREFIX}${ownerB64}/`;
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const nameB64 = k.slice(prefix.length);
          try {
            const decoded = new TextDecoder().decode(
              base64UrlToBytes(nameB64),
            );
            names.push(decoded);
          } catch {
            // Skip malformed entries (tampered by attacker).
          }
        }
      }
      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}

// --- helpers ---

function bytesToBase64Url(bytes: Uint8Array): string {
  // Build a binary string in chunks to avoid call-stack overflow on large inputs.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // Standard base64 → base64url
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(s: string): Uint8Array {
  // base64url → standard base64, then decode
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
