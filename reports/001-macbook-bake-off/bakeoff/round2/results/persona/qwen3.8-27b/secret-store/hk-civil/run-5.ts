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

  const SALT_KEY = "__secret_store_salt__";
  const SECRET_PREFIX = "secret:";
  const IV_LENGTH = 12;
  const PBKDF2_ITERATIONS = 100_000;

  // ── encoding helpers ──────────────────────────────────────────────

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
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

  function b64urlEncode(bytes: Uint8Array): string {
    return bytesToBase64(bytes)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    return base64ToBytes(b64);
  }

  // ── storage-key helpers ───────────────────────────────────────────

  function storageKey(owner: string, name: string): string {
    const o = b64urlEncode(new TextEncoder().encode(owner));
    const n = b64urlEncode(new TextEncoder().encode(name));
    return `${SECRET_PREFIX}${o}:${n}`;
  }

  function ownerPrefix(owner: string): string {
    const o = b64urlEncode(new TextEncoder().encode(owner));
    return `${SECRET_PREFIX}${o}:`;
  }

  // ── key derivation ────────────────────────────────────────────────

  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const fresh = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = bytesToBase64(fresh);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = base64ToBytes(saltB64);

  const passwordBytes = new TextEncoder().encode(masterPassword);
  const pbkdf2Key = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const aesKey: CryptoKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    pbkdf2Key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // ── public operations ─────────────────────────────────────────────

  async function put(owner: string, name: string, value: string): Promise<void> {
    const key = storageKey(owner, name);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const aad = new TextEncoder().encode(key);
    const plaintext = new TextEncoder().encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      aesKey,
      plaintext,
    );

    // layout: IV (12) || ciphertext-with-GCM-tag
    const blob = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ciphertext), IV_LENGTH);

    await storage.set(key, bytesToBase64(blob));
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const key = storageKey(owner, name);
    const stored = await storage.get(key);
    if (stored === undefined) return undefined;

    try {
      const data = base64ToBytes(stored);
      if (data.length < IV_LENGTH + 16) {
        throw new Error("Corrupted secret data");
      }
      const iv = data.slice(0, IV_LENGTH);
      const ct = data.slice(IV_LENGTH);
      const aad = new TextEncoder().encode(key);

      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        ct,
      );

      return new TextDecoder().decode(pt);
    } catch (e) {
      if (e instanceof Error && e.message === "Corrupted secret data") throw e;
      throw new Error("Failed to decrypt secret: tampering detected");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = ownerPrefix(owner);
    const allKeys = await storage.keys();
    const names: string[] = [];

    for (const k of allKeys) {
      if (!k.startsWith(prefix)) continue;
      const namePart = k.slice(prefix.length);
      try {
        const nameBytes = b64urlDecode(namePart);
        const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
        // round-trip check: reject attacker-injected keys with malformed names
        if (b64urlEncode(new TextEncoder().encode(name)) === namePart) {
          names.push(name);
        }
      } catch {
        // skip unparseable entries silently
      }
    }

    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = storageKey(owner, name);
    const existing = await storage.get(key);
    if (existing === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}
