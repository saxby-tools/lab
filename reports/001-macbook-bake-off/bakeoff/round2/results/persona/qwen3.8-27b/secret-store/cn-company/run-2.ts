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

/* ── base-64 helpers (no imports) ─────────────────────────────────── */

function b64Encode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── hex helper ────────────────────────────────────────────────────── */

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

/* ── main factory ──────────────────────────────────────────────────── */

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const SALT_KEY = "\x00__salt__";
  const PREFIX = "\x00secret.";

  /* ── load or create the PBKDF2 salt ── */
  let salt: Uint8Array;
  const raw = await storage.get(SALT_KEY);
  if (raw !== undefined) {
    try {
      salt = b64Decode(raw);
      if (salt.length < 16) throw new Error("bad");
    } catch {
      salt = crypto.getRandomValues(new Uint8Array(32));
      await storage.set(SALT_KEY, b64Encode(salt));
    }
  } else {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await storage.set(SALT_KEY, b64Encode(salt));
  }

  /* ── derive AES-256-GCM key from the master password ── */
  const pwdKey = await crypto.subtle.importKey(
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
    pwdKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /* ── helpers ── */

  function aadFor(owner: string, name: string): Uint8Array {
    return enc.encode(JSON.stringify([owner, name]));
  }

  async function storageKey(owner: string, name: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", aadFor(owner, name));
    return PREFIX + toHex(digest);
  }

  /* ── public API ── */

  async function put(owner: string, name: string, value: string): Promise<void> {
    const key = await storageKey(owner, name);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
      aesKey,
      enc.encode(value),
    );
    const blob = JSON.stringify({
      o: owner,
      n: name,
      iv: b64Encode(iv),
      ct: b64Encode(new Uint8Array(ct)),
    });
    await storage.set(key, blob);
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const key = await storageKey(owner, name);
    const raw = await storage.get(key);
    if (raw === undefined) return undefined;

    let payload: { iv: string; ct: string };
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.iv !== "string" || typeof parsed.ct !== "string") {
        throw new Error("malformed");
      }
      payload = parsed;
    } catch {
      throw new Error("Tampered secret data");
    }

    try {
      const iv = b64Decode(payload.iv);
      const ct = b64Decode(payload.ct);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
        aesKey,
        ct,
      );
      return dec.decode(pt);
    } catch {
      throw new Error("Tampered secret data");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const allKeys = await storage.keys();
    const names: string[] = [];
    for (const k of allKeys) {
      if (!k.startsWith(PREFIX)) continue;
      try {
        const raw = await storage.get(k);
        if (raw === undefined) continue;
        const parsed = JSON.parse(raw);
        if (parsed.o === owner && typeof parsed.n === "string") {
          names.push(parsed.n);
        }
      } catch {
        // skip malformed or deleted entries
      }
    }
    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = await storageKey(owner, name);
    const raw = await storage.get(key);
    if (raw === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}
