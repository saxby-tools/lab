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
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const IV_LEN = 12;

  // ── Derive a 256-bit AES-GCM key from the master password ──────────
  const SALT_KEY = "\x00meta:salt";
  let raw = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (raw === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await storage.set(SALT_KEY, toB64(salt));
  } else {
    salt = fromB64(raw);
  }

  const pwdKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    pwdKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // ── Storage-key helpers ─────────────────────────────────────────────
  // encodeURIComponent never emits ':', so the two colons are unambiguous
  // delimiters.  The resulting key is unique for every (owner, name) pair.
  function secretKey(owner: string, name: string): string {
    return `secret:${encodeURIComponent(owner)}:${encodeURIComponent(name)}`;
  }

  // ── Public API ──────────────────────────────────────────────────────
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
      // AAD binds the ciphertext to the exact (owner, name) pair so that
      // copying one secret's blob onto another's key will fail authentication.
      const aad = textEncoder.encode(secretKey(owner, name));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        textEncoder.encode(value),
      );
      // Layout: [ iv (12) | ciphertext + GCM tag ]
      const blob = new Uint8Array(IV_LEN + ct.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(ct), IV_LEN);
      await storage.set(secretKey(owner, name), toB64(blob));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = secretKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;
      try {
        const blob = fromB64(stored);
        if (blob.length < IV_LEN + 16) throw new Error("truncated blob");
        const iv = blob.slice(0, IV_LEN);
        const ct = blob.slice(IV_LEN);
        const aad = textEncoder.encode(key);
        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          aesKey,
          ct,
        );
        return textDecoder.decode(pt);
      } catch {
        // Invalid base64, wrong key (wrong master password), tampered
        // ciphertext, or copied data – all surface as a decryption failure.
        throw new Error("Failed to decrypt secret");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = `secret:${encodeURIComponent(owner)}:`;
      const all = await storage.keys();
      const names: string[] = [];
      for (const k of all) {
        if (k.startsWith(prefix)) {
          try {
            names.push(decodeURIComponent(k.slice(prefix.length)));
          } catch {
            // skip keys with malformed percent-encoding
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = secretKey(owner, name);
      const val = await storage.get(key);
      if (val === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}

// ── Base-64 helpers (no external imports) ────────────────────────────
function toB64(buf: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    buf[i] = bin.charCodeAt(i);
  }
  return buf;
}
