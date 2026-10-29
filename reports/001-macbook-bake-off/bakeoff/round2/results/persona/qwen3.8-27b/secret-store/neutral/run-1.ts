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

/* ── base-64 helpers (no imports needed) ─────────────────────────────── */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 4096;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/* ── main export ─────────────────────────────────────────────────────── */

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* --- salt (persisted so a fresh store with the same password works) --- */

  const SALT_KEY = "\x00__secret_store_salt__\x00";

  let salt: Uint8Array;
  const existingSalt = await storage.get(SALT_KEY);
  if (existingSalt !== undefined) {
    try {
      salt = base64ToBytes(existingSalt);
    } catch {
      salt = crypto.getRandomValues(new Uint8Array(32));
      await storage.set(SALT_KEY, bytesToBase64(salt));
    }
  } else {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await storage.set(SALT_KEY, bytesToBase64(salt));
  }

  /* --- derive a 256-bit AES key from the master password ---------------- */

  const pwKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    pwKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /* --- key / AAD helpers ------------------------------------------------ */

  // Storage key:  sec|<base64(owner)>|<base64(name)>
  // base-64 output only contains [A-Za-z0-9+/=], so '|' is a safe
  // delimiter even when owner/name contain ':' '/' '|' spaces, etc.
  function keyFor(owner: string, name: string): string {
    return `sec|${bytesToBase64(enc.encode(owner))}|${bytesToBase64(enc.encode(name))}`;
  }

  // Associated data binds the ciphertext to (owner, name) so that copying
  // one secret's blob onto another's slot (even within the same owner)
  // will fail the GCM auth-tag check.
  function aadFor(owner: string, name: string): Uint8Array {
    const o = enc.encode(owner);
    const n = enc.encode(name);
    const buf = new Uint8Array(o.length + 1 + n.length);
    buf.set(o, 0);
    buf[o.length] = 0x00; // NUL separator prevents prefix ambiguity
    buf.set(n, o.length + 1);
    return buf;
  }

  /* --- public API ------------------------------------------------------- */

  async function put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.randomValues
      ? crypto.randomValues(new Uint8Array(12))   // future-proof
      : crypto.getRandomValues(new Uint8Array(12));
    const pt = enc.encode(value);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
      aesKey,
      pt,
    );
    // stored blob = 12-byte IV ‖ GCM ciphertext (includes 16-byte tag)
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), 12);
    await storage.set(keyFor(owner, name), bytesToBase64(blob));
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const raw = await storage.get(keyFor(owner, name));
    if (raw === undefined) return undefined;
    try {
      const blob = base64ToBytes(raw);
      const iv = blob.slice(0, 12);
      const ct = blob.slice(12);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
        aesKey,
        ct,
      );
      return dec.decode(pt);
    } catch (err) {
      // Any failure — bad base64, short blob, wrong key, tampered data —
      // means the stored value cannot be trusted.
      if (err instanceof Error) throw err;
      throw new Error("Tampering detected or corrupted secret data");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = `sec|${bytesToBase64(enc.encode(owner))}|`;
    const allKeys = await storage.keys();
    const names: string[] = [];
    for (const k of allKeys) {
      if (k.startsWith(prefix)) {
        try {
          names.push(dec.decode(base64ToBytes(k.slice(prefix.length))));
        } catch {
          // skip unparseable / attacker-inserted keys
        }
      }
    }
    names.sort(); // default Array.prototype.sort — lexicographic by code unit
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const k = keyFor(owner, name);
    if ((await storage.get(k)) === undefined) return false;
    await storage.delete(k);
    return true;
  }

  return { put, get, list, remove };
}
