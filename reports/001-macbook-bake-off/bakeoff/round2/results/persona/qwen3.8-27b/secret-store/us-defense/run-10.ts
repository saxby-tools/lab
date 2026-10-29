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
const SECRET_PREFIX = "secret|";
const PBKDF2_ITERATIONS = 100_000;
const IV_LEN = 12;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hkdfInfo(owner: string, name: string): Uint8Array {
  const enc = new TextEncoder();
  const o = enc.encode(owner);
  const n = enc.encode(name);
  const buf = new Uint8Array(8 + o.length + n.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, o.length, false);
  buf.set(o, 4);
  dv.setUint32(4 + o.length, n.length, false);
  buf.set(n, 8 + o.length);
  return buf;
}

function storageKey(owner: string, name: string): string {
  const enc = new TextEncoder();
  return SECRET_PREFIX + toB64(enc.encode(owner)) + "|" + toB64(enc.encode(name));
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── Salt ──────────────────────────────────────────────────────────
  let salt: Uint8Array;
  const raw = await storage.get(SALT_KEY);
  if (raw === undefined) {
    salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    await storage.set(SALT_KEY, toB64(salt));
  } else {
    salt = fromB64(raw);
  }

  // ── Master key material via PBKDF2 ────────────────────────────────
  const pwKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const masterBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    pwKey,
    256,
  );

  const hkdfBase = await crypto.subtle.importKey(
    "raw",
    masterBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  // ── Per-secret AES-GCM key ────────────────────────────────────────
  async function aesKey(owner: string, name: string): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: hkdfInfo(owner, name),
      },
      hkdfBase,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  // ── Public API ────────────────────────────────────────────────────
  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = storageKey(owner, name);
      const k = await aesKey(owner, name);
      const iv = new Uint8Array(IV_LEN);
      crypto.getRandomValues(iv);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        k,
        enc.encode(value),
      );
      const blob = new Uint8Array(IV_LEN + ct.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(ct), IV_LEN);
      await storage.set(key, toB64(blob));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = storageKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;
      const blob = fromB64(stored);
      if (blob.length < IV_LEN + 16) throw new Error("Corrupted secret");
      const iv = blob.slice(0, IV_LEN);
      const ct = blob.slice(IV_LEN);
      const k = await aesKey(owner, name);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        k,
        ct,
      );
      return dec.decode(pt);
    },

    async list(owner: string): Promise<string[]> {
      const prefix = SECRET_PREFIX + toB64(enc.encode(owner)) + "|";
      const names: string[] = [];
      for (const k of await storage.keys()) {
        if (k.startsWith(prefix)) {
          names.push(dec.decode(fromB64(k.slice(prefix.length))));
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKey(owner, name);
      if (await storage.get(key) === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
