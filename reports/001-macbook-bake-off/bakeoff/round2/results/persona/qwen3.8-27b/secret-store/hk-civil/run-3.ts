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
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── encoding helpers ──────────────────────────────────────────────

  function b64e(s: string): string {
    const bytes = enc.encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function b64d(s: string): string {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return dec.decode(bytes);
  }

  function bytesToB64(buf: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < buf.length; i++) {
      bin += String.fromCharCode(buf[i]);
    }
    return btoa(bin);
  }

  function b64ToBytes(s: string): Uint8Array {
    const bin = atob(s);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      buf[i] = bin.charCodeAt(i);
    }
    return buf;
  }

  function toHex(buf: Uint8Array): string {
    let s = "";
    for (let i = 0; i < buf.length; i++) {
      s += buf[i].toString(16).padStart(2, "0");
    }
    return s;
  }

  function fromHex(s: string): Uint8Array {
    const buf = new Uint8Array(s.length / 2);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return buf;
  }

  // ── storage key ───────────────────────────────────────────────────
  // Owner and name are base64-encoded so that arbitrary characters
  // (colons, slashes, newlines, …) cannot collide or confuse the
  // prefix-matching used by `list`.

  function keyFor(owner: string, name: string): string {
    return `secret:${b64e(owner)}:${b64e(name)}`;
  }

  // ── key derivation ────────────────────────────────────────────────
  // PBKDF2-SHA-256, 100 000 iterations, 256-bit key.
  // A random 256-bit salt is persisted in storage so that a store
  // recreated with the same password derives the same key.

  const SALT_KEY = "meta:salt";
  let saltHex = await storage.get(SALT_KEY);
  if (saltHex === undefined || saltHex === "") {
    const salt = new Uint8Array(32);
    crypto.getRandomValues(salt);
    saltHex = toHex(salt);
    await storage.set(SALT_KEY, saltHex);
  }
  const salt = fromHex(saltHex);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const keyBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBits,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

  // ── operations ────────────────────────────────────────────────────
  // Each secret is stored as  base64( nonce ‖ ciphertext-with-GCM-tag )
  // The storage key itself is used as the GCM additional-data (AAD),
  // which binds the ciphertext to a specific (owner, name) pair and
  // prevents cross-secret copy attacks.

  async function put(owner: string, name: string, value: string): Promise<void> {
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);

    const aad = enc.encode(keyFor(owner, name));
    const plaintext = enc.encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", nonce, additionalData: aad },
      aesKey,
      plaintext,
    );

    const blob = new Uint8Array(nonce.length + ciphertext.byteLength);
    blob.set(nonce, 0);
    blob.set(new Uint8Array(ciphertext), nonce.length);

    await storage.set(keyFor(owner, name), bytesToB64(blob));
  }

  async function get(
    owner: string,
    name: string,
  ): Promise<string | undefined> {
    const raw = await storage.get(keyFor(owner, name));
    if (raw === undefined) return undefined;

    let blob: Uint8Array;
    try {
      blob = b64ToBytes(raw);
    } catch {
      throw new Error("Invalid secret data: not valid base64");
    }

    // Minimum: 12-byte nonce + 16-byte GCM tag = 28 bytes
    if (blob.length < 28) {
      throw new Error("Invalid secret data: too short");
    }

    const nonce = blob.subarray(0, 12);
    const ciphertext = blob.subarray(12);
    const aad = enc.encode(keyFor(owner, name));

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", nonce, additionalData: aad },
        aesKey,
        ciphertext,
      );
      return dec.decode(plaintext);
    } catch {
      throw new Error("Tamper detected or decryption failed");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = `secret:${b64e(owner)}:`;
    const all = await storage.keys();
    const names: string[] = [];
    for (const k of all) {
      if (k.startsWith(prefix) && k.length > prefix.length) {
        try {
          names.push(b64d(k.slice(prefix.length)));
        } catch {
          // skip entries that an attacker may have forged
        }
      }
    }
    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const k = keyFor(owner, name);
    const existing = await storage.get(k);
    if (existing === undefined) return false;
    await storage.delete(k);
    return true;
  }

  return { put, get, list, remove };
}
