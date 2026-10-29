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

  const SALT_KEY = "__meta__salt";
  const CANARY_KEY = "__meta__canary";
  const SECRET_PREFIX = "secret:";
  const PBKDF2_ITERATIONS = 100_000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const CANARY_PLAINTEXT = "secret-store-canary-v1";

  // --- encoding helpers ---------------------------------------------------

  function toB64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromB64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function encodePart(s: string): string {
    return toB64(new TextEncoder().encode(s));
  }

  function decodePart(s: string): string {
    return new TextDecoder().decode(fromB64(s));
  }

  function storageKey(owner: string, name: string): string {
    return `${SECRET_PREFIX}${encodePart(owner)}:${encodePart(name)}`;
  }

  // AAD binds encryption to a specific (owner, name) pair.
  // Length-prefixed to avoid ambiguity when strings contain NUL bytes.
  function aadFor(owner: string, name: string): Uint8Array {
    const o = new TextEncoder().encode(owner);
    const n = new TextEncoder().encode(name);
    const buf = new Uint8Array(8 + o.length + n.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, o.length, false);
    dv.setUint32(4, n.length, false);
    buf.set(o, 8);
    buf.set(n, 8 + o.length);
    return buf;
  }

  // --- key derivation & canary -------------------------------------------

  let salt: Uint8Array;
  const storedSalt = await storage.get(SALT_KEY);

  if (storedSalt === undefined) {
    salt = new Uint8Array(SALT_BYTES);
    crypto.getRandomValues(salt);
    await storage.set(SALT_KEY, toB64(salt));
  } else {
    salt = fromB64(storedSalt);
  }

  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey: CryptoKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Canary: a known-plaintext blob encrypted with the derived key.
  // If the password is wrong (or salt was tampered), this will not verify.
  const storedCanary = await storage.get(CANARY_KEY);

  if (storedCanary === undefined) {
    const iv = new Uint8Array(IV_BYTES);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("canary") },
      aesKey,
      new TextEncoder().encode(CANARY_PLAINTEXT),
    );
    const blob = new Uint8Array(iv.length + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), iv.length);
    await storage.set(CANARY_KEY, toB64(blob));
  } else {
    try {
      const blob = fromB64(storedCanary);
      if (blob.length <= IV_BYTES) throw new Error("bad canary");
      const iv = blob.slice(0, IV_BYTES);
      const ct = blob.slice(IV_BYTES);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("canary") },
        aesKey,
        ct,
      );
      if (new TextDecoder().decode(pt) !== CANARY_PLAINTEXT) {
        throw new Error("canary mismatch");
      }
    } catch {
      throw new Error("Invalid master password or corrupted metadata");
    }
  }

  // --- encrypt / decrypt helpers -----------------------------------------

  async function encrypt(
    value: string,
    owner: string,
    name: string,
  ): Promise<string> {
    const iv = new Uint8Array(IV_BYTES);
    crypto.getRandomValues(iv);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
      aesKey,
      new TextEncoder().encode(value),
    );
    const blob = new Uint8Array(iv.length + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), iv.length);
    return toB64(blob);
  }

  function decrypt(encoded: string, owner: string, name: string): Promise<string> {
    let blob: Uint8Array;
    try {
      blob = fromB64(encoded);
    } catch {
      return Promise.reject(new Error("Tamper detected: secret data is corrupted"));
    }
    if (blob.length <= IV_BYTES) {
      return Promise.reject(new Error("Tamper detected: secret data is corrupted"));
    }
    const iv = blob.slice(0, IV_BYTES);
    const ct = blob.slice(IV_BYTES);
    return crypto.subtle
      .decrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
        aesKey,
        ct,
      )
      .then((pt) => new TextDecoder().decode(pt))
      .catch((e: unknown) => {
        throw new Error("Tamper detected: secret data is corrupted");
      });
  }

  // --- public API --------------------------------------------------------

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      await storage.set(
        storageKey(owner, name),
        await encrypt(value, owner, name),
      );
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const stored = await storage.get(storageKey(owner, name));
      if (stored === undefined) return undefined;
      // Any failure (bad base64, GCM auth failure, bad UTF-8) ⇒ tamper
      return decrypt(stored, owner, name);
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const prefix = `${SECRET_PREFIX}${encodePart(owner)}:`;
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const raw = k.slice(prefix.length);
          try {
            names.push(decodePart(raw));
          } catch {
            // skip entries that are not valid (attacker-injected junk)
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
