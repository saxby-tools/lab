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

  /* ── constants ─────────────────────────────────────────────────────── */

  const SALT_KEY = "__ss__salt";
  const INDEX_PREFIX = "__ss__idx__";
  const SECRET_PREFIX = "__ss__sec__";
  const PBKDF2_ITERATIONS = 100_000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12; // GCM standard nonce size

  /* ── helpers ────────────────────────────────────────────────────────── */

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function bytesToB64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  function strToB64(s: string): string {
    return bytesToB64(enc.encode(s));
  }

  /**
   * Unambiguous encoding of (owner, name) into bytes.
   * Layout: [4-byte BE owner-byte-length][owner UTF-8][name UTF-8]
   * This handles names/owners that contain NUL bytes.
   */
  function encodePair(owner: string, name: string): Uint8Array {
    const ownerBytes = enc.encode(owner);
    const nameBytes = enc.encode(name);
    const out = new Uint8Array(4 + ownerBytes.length + nameBytes.length);
    out[0] = (ownerBytes.length >>> 24) & 0xff;
    out[1] = (ownerBytes.length >>> 16) & 0xff;
    out[2] = (ownerBytes.length >>> 8) & 0xff;
    out[3] = ownerBytes.length & 0xff;
    out.set(ownerBytes, 4);
    out.set(nameBytes, 4 + ownerBytes.length);
    return out;
  }

  function secretStorageKey(owner: string, name: string): string {
    return SECRET_PREFIX + bytesToB64(encodePair(owner, name));
  }

  function indexStorageKey(owner: string): string {
    return INDEX_PREFIX + strToB64(owner);
  }

  /* ── key derivation ─────────────────────────────────────────────────── */

  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    saltB64 = bytesToB64(salt);
    await storage.set(SALT_KEY, saltB64);
  }

  const salt = b64ToBytes(saltB64);

  const pbkdf2Key = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    pbkdf2Key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  /* ── index helpers ──────────────────────────────────────────────────── */

  async function readIndex(owner: string): Promise<string[]> {
    const raw = await storage.get(indexStorageKey(owner));
    if (raw === undefined) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed;
      }
    } catch { /* ignore corrupt index */ }
    return [];
  }

  async function writeIndex(owner: string, names: string[]): Promise<void> {
    const key = indexStorageKey(owner);
    if (names.length === 0) {
      await storage.delete(key);
    } else {
      await storage.set(key, JSON.stringify(names));
    }
  }

  /* ── public API ─────────────────────────────────────────────────────── */

  async function put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const aad = encodePair(owner, name);
    const plaintext = enc.encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad as BufferSource },
      aesKey,
      plaintext,
    );

    // stored blob: iv (12) || ciphertext+tag
    const blob = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ciphertext), IV_BYTES);

    await storage.set(secretStorageKey(owner, name), bytesToB64(blob));

    // keep the per-owner index up to date
    const names = await readIndex(owner);
    if (!names.includes(name)) names.push(name);
    await writeIndex(owner, names);
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const raw = await storage.get(secretStorageKey(owner, name));
    if (raw === undefined) return undefined;

    let blob: Uint8Array;
    try {
      blob = b64ToBytes(raw);
    } catch {
      throw new Error("Corrupt secret data");
    }

    // must be at least IV (12) + GCM tag (16)
    if (blob.length < IV_BYTES + 16) {
      throw new Error("Corrupt secret data");
    }

    const iv = blob.slice(0, IV_BYTES);
    const ct = blob.slice(IV_BYTES);
    const aad = encodePair(owner, name);

    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad as BufferSource },
        aesKey,
        ct as BufferSource,
      );
    } catch {
      throw new Error("Decryption failed: tampered data or wrong password");
    }

    return dec.decode(plaintext);
  }

  async function list(owner: string): Promise<string[]> {
    const names = await readIndex(owner);
    return names.sort();
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = secretStorageKey(owner, name);
    const raw = await storage.get(key);
    if (raw === undefined) return false;

    await storage.delete(key);

    const names = await readIndex(owner);
    const idx = names.indexOf(name);
    if (idx !== -1) {
      names.splice(idx, 1);
      await writeIndex(owner, names);
    }

    return true;
  }

  return { put, get, list, remove };
}
