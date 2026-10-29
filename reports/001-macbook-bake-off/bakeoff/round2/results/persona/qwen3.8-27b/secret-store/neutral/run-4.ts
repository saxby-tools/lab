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

const SALT_KEY = "__secret_store__salt";
const PREFIX = "secret:";
const NONCE_LEN = 12;
const ITERATIONS = 100_000;

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Retrieve or create the PBKDF2 salt persisted in storage.
  let saltB64 = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = new Uint8Array(32);
    crypto.getRandomValues(salt);
    saltB64 = toBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = fromBase64(saltB64);

  // Derive an AES-256-GCM key from the master password.
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // Key helpers – encodeURIComponent guarantees no ':' in the output,
  // so the two literal ':' act as unambiguous separators.
  function secretKey(owner: string, name: string): string {
    return `${PREFIX}${encodeURIComponent(owner)}:${encodeURIComponent(name)}`;
  }

  function ownerPrefix(owner: string): string {
    return `${PREFIX}${encodeURIComponent(owner)}:`;
  }

  // Bound each ciphertext to its owner/name so that copying one secret's
  // blob onto another's key causes GCM authentication to fail.
  function aad(owner: string, name: string): Uint8Array {
    return enc.encode(`${owner}\0${name}`);
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = new Uint8Array(NONCE_LEN);
      crypto.getRandomValues(iv);

      const ctBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(owner, name) },
        aesKey,
        enc.encode(value),
      );

      // Layout: [nonce(12 bytes)][ciphertext || GCM tag]
      const blob = new Uint8Array(NONCE_LEN + ctBuf.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(ctBuf), NONCE_LEN);

      await storage.set(secretKey(owner, name), toBase64(blob));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const raw = await storage.get(secretKey(owner, name));
      if (raw === undefined) return undefined;

      try {
        const data = fromBase64(raw);
        if (data.length < NONCE_LEN + 16) {
          throw new Error("corrupt");
        }
        const iv = data.slice(0, NONCE_LEN);
        const ct = data.slice(NONCE_LEN);
        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad(owner, name) },
          aesKey,
          ct,
        );
        return dec.decode(pt);
      } catch {
        throw new Error("integrity check failed – secret may have been tampered with");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = ownerPrefix(owner);
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.length > prefix.length && k.startsWith(prefix)) {
          try {
            names.push(decodeURIComponent(k.slice(prefix.length)));
          } catch {
            // skip keys that don't decode cleanly
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const k = secretKey(owner, name);
      const raw = await storage.get(k);
      if (raw === undefined) return false;
      await storage.delete(k);
      return true;
    },
  };
}

// ---- helpers (no imports) ----

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
