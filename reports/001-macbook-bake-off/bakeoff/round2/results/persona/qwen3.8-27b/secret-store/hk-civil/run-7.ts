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

// ── helpers ──────────────────────────────────────────────────────────────────

const FIXED_SALT = new TextEncoder().encode("hk-civil-society-secret-store-v1");

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
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

/** Deterministic, collision-free encoding of an arbitrary string into a
 *  base-64 token that never contains NUL, so it is safe as a key fragment. */
function enc(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

function dec(token: string): string {
  return new TextDecoder().decode(base64ToBytes(token));
}

// ── main factory ─────────────────────────────────────────────────────────────

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Derive a 256-bit AES key from the master password (PBKDF2, fixed salt).
  const pwKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey: CryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: FIXED_SALT,
      iterations: 100_000,
      hash: "SHA-256",
    },
    pwKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Storage-key layout:
  //   ss\u0000secret\u0000<base64(owner)>\u0000<base64(name)>
  // The NUL separator never appears inside a base-64 string, so the prefix
  // for list() is unambiguous even when owner names contain ':', '/', etc.

  const PREFIX = "ss\u0000secret\u0000";

  function storageKey(owner: string, name: string): string {
    return `${PREFIX}${enc(owner)}\u0000${enc(name)}`;
  }

  function ownerPrefix(owner: string): string {
    return `${PREFIX}${enc(owner)}\u0000`;
  }

  // ── put ────────────────────────────────────────────────────────────────────

  async function put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(value);
    const key = storageKey(owner, name);
    // Bind the ciphertext to its storage key via AAD so that copying one
    // secret's blob onto another key (or any byte-flip) fails GCM auth.
    const aad = new TextEncoder().encode(key);

    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      aesKey,
      plaintext,
    );

    // Layout on disk:  iv(12) || ciphertext+tag
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), 12);

    await storage.set(key, bytesToBase64(blob));
  }

  // ── get ────────────────────────────────────────────────────────────────────

  async function get(owner: string, name: string): Promise<string | undefined> {
    const key = storageKey(owner, name);
    const stored = await storage.get(key);
    if (stored === undefined) return undefined;

    try {
      const blob = base64ToBytes(stored);
      if (blob.length < 12) throw new Error("data too short");

      const iv = blob.slice(0, 12);
      const ct = blob.slice(12);
      const aad = new TextEncoder().encode(key);

      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        ct,
      );

      return new TextDecoder().decode(plaintext);
    } catch (e) {
      // Either the stored data was tampered with, or the master password is
      // wrong (GCM authentication tag will not verify).  Either way the
      // caller gets an Error instead of a (possibly garbage) value.
      throw new Error("Unable to decrypt secret");
    }
  }

  // ── list ───────────────────────────────────────────────────────────────────

  async function list(owner: string): Promise<string[]> {
    const prefix = ownerPrefix(owner);
    const allKeys = await storage.keys();
    const names: string[] = [];

    for (const k of allKeys) {
      if (k.startsWith(prefix)) {
        const token = k.slice(prefix.length);
        names.push(dec(token));
      }
    }

    names.sort();
    return names;
  }

  // ── remove ─────────────────────────────────────────────────────────────────

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = storageKey(owner, name);
    const existing = await storage.get(key);
    if (existing === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}
