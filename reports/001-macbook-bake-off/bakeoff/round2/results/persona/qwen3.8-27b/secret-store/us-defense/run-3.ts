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

// ─── constants ────────────────────────────────────────────────────────────
const SALT_KEY = "__ss_salt_v1__";
const SECRET_PREFIX = "secret|";
const PBKDF2_ROUNDS = 100_000;

// ─── base-64 helpers ──────────────────────────────────────────────────────
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

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return fromB64(b);
}

// ─── key-part encoding (handles any character, including : / | etc.) ─────
function encPart(str: string): string {
  return toB64Url(new TextEncoder().encode(str));
}

function decPart(s: string): string {
  return new TextDecoder().decode(fromB64Url(s));
}

// ─── storage key for a secret ─────────────────────────────────────────────
// Format: secret|<b64url(owner)>|<b64url(name)>
// b64url alphabet is [A-Za-z0-9_-] so '|' is a safe delimiter.
function sk(owner: string, name: string): string {
  return `${SECRET_PREFIX}${encPart(owner)}|${encPart(name)}`;
}

// ─── factory ──────────────────────────────────────────────────────────────
export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // 1. Obtain (or create) the PBKDF2 salt, persisted in storage.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = fromB64(saltB64);

  // 2. Derive a 256-bit master key from the password.
  const pwKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const masterBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    pwKey,
    256,
  );

  // 3. Import the master key as an HKDF base key so we can derive
  //    per-secret keys (binds encryption to owner+name, preventing
  //    cross-slot data copying).
  const hkdfBase = await crypto.subtle.importKey(
    "raw",
    masterBits,
    { name: "HKDF", hash: "SHA-256" },
    false,
    ["deriveKey"],
  );

  // Derive an AES-256-GCM key for a specific (owner, name) pair.
  const deriveSecretKey = (owner: string, name: string): Promise<CryptoKey> => {
    const info = new TextEncoder().encode(`ss:v1:${owner}\0${name}`);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info,
      },
      hkdfBase,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  };

  // ── put ──────────────────────────────────────────────────────────────────
  async function put(owner: string, name: string, value: string): Promise<void> {
    const aesKey = await deriveSecretKey(owner, name);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      new TextEncoder().encode(value),
    );
    // Store  [ iv (12 bytes) | ciphertext + GCM tag ]
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), 12);
    await storage.set(sk(owner, name), toB64(blob));
  }

  // ── get ──────────────────────────────────────────────────────────────────
  async function get(owner: string, name: string): Promise<string | undefined> {
    const stored = await storage.get(sk(owner, name));
    if (stored === undefined) return undefined;

    try {
      const raw = fromB64(stored);
      const iv = raw.subarray(0, 12);
      const ct = raw.subarray(12);
      const aesKey = await deriveSecretKey(owner, name);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        aesKey,
        ct,
      );
      return new TextDecoder().decode(pt);
    } catch {
      // Any failure (bad base64, wrong key, GCM auth tag mismatch, …)
      // means the data is tampered or was written with a different password.
      throw new Error("Tampered or corrupt secret data");
    }
  }

  // ── list ─────────────────────────────────────────────────────────────────
  async function list(owner: string): Promise<string[]> {
    const prefix = `${SECRET_PREFIX}${encPart(owner)}|`;
    const names: string[] = [];
    for (const k of await storage.keys()) {
      if (k.startsWith(prefix)) {
        try {
          names.push(decPart(k.slice(prefix.length)));
        } catch {
          // Skip keys with undecodable name segments (attacker-injected junk).
        }
      }
    }
    return names.sort();
  }

  // ── remove ───────────────────────────────────────────────────────────────
  async function remove(owner: string, name: string): Promise<boolean> {
    const k = sk(owner, name);
    if (await storage.get(k) === undefined) return false;
    await storage.delete(k);
    return true;
  }

  return { put, get, list, remove };
}
