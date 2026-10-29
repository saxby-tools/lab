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

const SALT_KEY = "__master_salt__";
const SECRET_PREFIX = "secret/";
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 600_000;
const HASH = "SHA-256";
const KEY_LEN = 256;

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("Invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build an unambiguous AAD from owner + name using length-prefixed
 * framing so that no (owner, name) pair can collide with another.
 *
 *   [ 4-byte BE owner-utf8 length ][ owner utf-8 ][ 4-byte BE name-utf8 length ][ name utf-8 ]
 */
function makeAAD(owner: string, name: string): Uint8Array {
  const enc = new TextEncoder();
  const o = enc.encode(owner);
  const n = enc.encode(name);
  const aad = new Uint8Array(4 + o.length + 4 + n.length);
  const dv = new DataView(aad.buffer);
  dv.setUint32(0, o.length, false);
  aad.set(o, 4);
  dv.setUint32(4 + o.length, n.length, false);
  aad.set(n, 8 + o.length);
  return aad;
}

/**
 * Deterministic storage key for a secret.
 * Owner and name are hex-encoded so that no delimiter can appear inside
 * either component, making the two-part key unambiguously parseable.
 */
function secretKeyFor(owner: string, name: string): string {
  return `${SECRET_PREFIX}${bytesToHex(new TextEncoder().encode(owner))}:${bytesToHex(new TextEncoder().encode(name))}`;
}

function ownerPrefixFor(owner: string): string {
  return `${SECRET_PREFIX}${bytesToHex(new TextEncoder().encode(owner))}:`;
}

function nameFromStorageKey(key: string, prefix: string): string {
  const hex = key.slice(prefix.length);
  return new TextDecoder().decode(hexToBytes(hex));
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // --- Salt: create on first use, reuse thereafter -------------------------
  const existing = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (existing !== undefined) {
    try {
      salt = hexToBytes(existing);
    } catch {
      // Salt was tampered; generate a fresh one (old secrets become
      // undecryptable, which is the correct "tamper detected" outcome).
      salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
      await storage.set(SALT_KEY, bytesToHex(salt));
    }
  } else {
    salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    await storage.set(SALT_KEY, bytesToHex(salt));
  }

  // --- Derive a 256-bit AES-GCM key from the master password ---------------
  const pbkdf2BaseKey: CryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey: CryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: HASH,
    },
    pbkdf2BaseKey,
    { name: "AES-GCM", length: KEY_LEN },
    false,
    ["encrypt", "decrypt"],
  );

  // --- Public API ----------------------------------------------------------

  async function put(owner: string, name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const aad = makeAAD(owner, name);
    const plaintext = new TextEncoder().encode(value);

    const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      aesKey,
      plaintext,
    );

    // Layout on disk: [ 12-byte IV ][ ciphertext ‖ 16-byte GCM tag ]
    const combined = new Uint8Array(IV_LEN + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), IV_LEN);

    await storage.set(secretKeyFor(owner, name), bytesToHex(combined));
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const stored = await storage.get(secretKeyFor(owner, name));
    if (stored === undefined) return undefined;

    let combined: Uint8Array;
    try {
      combined = hexToBytes(stored);
    } catch {
      throw new Error("Tampering detected: stored data is corrupted");
    }

    if (combined.length < IV_LEN + 16) {
      throw new Error("Tampering detected: stored data is too short");
    }

    const iv = combined.slice(0, IV_LEN);
    const ct = combined.slice(IV_LEN);
    const aad = makeAAD(owner, name);

    try {
      const plaintext: ArrayBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        ct,
      );
      return new TextDecoder().decode(new Uint8Array(plaintext));
    } catch {
      throw new Error("Tampering detected: secret integrity check failed");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const prefix = ownerPrefixFor(owner);
    const allKeys = await storage.keys();
    const names: string[] = [];
    for (const key of allKeys) {
      if (key === prefix) continue; // malformed / incomplete key
      if (key.startsWith(prefix)) {
        const hexName = key.slice(prefix.length);
        // Skip entries that are not valid hex so a tampered key does not
        // crash the listing; it will simply be invisible to `list`.
        if (/^[0-9a-f]+$/i.test(hexName) && hexName.length % 2 === 0) {
          try {
            names.push(new TextDecoder().decode(hexToBytes(hexName)));
          } catch {
            // undecodable – skip
          }
        }
      }
    }
    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const key = secretKeyFor(owner, name);
    const stored = await storage.get(key);
    if (stored === undefined) return false;
    await storage.delete(key);
    return true;
  }

  return { put, get, list, remove };
}
