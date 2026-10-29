// solution.ts
// Secret store for a U.S. defense contractor.
// Secrets are encrypted with AES-256-GCM (authenticated encryption) keyed by a
// PBKDF2-derived key from the master password.  Owner+name are bound into the
// GCM associated-data so that copying one secret's blob onto another key
// causes authentication to fail.  A per-owner index (stored as JSON) backs
// list(); each secret's ciphertext lives under its own storage key.

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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// base64 output is [A-Za-z0-9+/=], so ':' and '|' are safe separators.
function dataKey(owner: string, name: string): string {
  return (
    "\0ss:data:" +
    toBase64(enc.encode(owner)) +
    "|" +
    toBase64(enc.encode(name))
  );
}

function indexKey(owner: string): string {
  return "\0ss:idx:" + toBase64(enc.encode(owner));
}

const SALT_KEY = "\0ss:salt";

// AAD binds the ciphertext to (owner, name).  A NUL byte separates the two
// fields so that ("a","bc") and ("abc","") produce different AAD.
function makeAAD(owner: string, name: string): Uint8Array {
  const o = enc.encode(owner);
  const n = enc.encode(name);
  const aad = new Uint8Array(o.length + 1 + n.length);
  aad.set(o, 0);
  aad[o.length] = 0;
  aad.set(n, o.length + 1);
  return aad;
}

/* ------------------------------------------------------------------ */
/*  createSecretStore                                                  */
/* ------------------------------------------------------------------ */

const PBKDF2_ITERATIONS = 100_000;
const KEY_BITS = 256;
const NONCE_BYTES = 12; // 96-bit IV recommended for GCM

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // ---- derive key -------------------------------------------------

  let saltB64 = await storage.get(SALT_KEY);
  let salt: Uint8Array;
  if (saltB64 === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    saltB64 = toBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  } else {
    salt = fromBase64(saltB64);
  }

  const passwordHandle = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey: CryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordHandle,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );

  // ---- store object -----------------------------------------------

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const aad = makeAAD(owner, name);
      const plaintext = enc.encode(value);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad },
        aesKey,
        plaintext,
      );

      // stored blob = nonce (12 B) || ciphertext+tag
      const combined = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
      combined.set(nonce, 0);
      combined.set(new Uint8Array(ciphertext), NONCE_BYTES);

      await storage.set(dataKey(owner, name), toBase64(combined));

      // maintain per-owner index
      const iKey = indexKey(owner);
      const raw = await storage.get(iKey);
      const names: string[] = raw ? JSON.parse(raw) : [];
      if (!names.includes(name)) {
        names.push(name);
      }
      await storage.set(iKey, JSON.stringify(names));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const raw = await storage.get(dataKey(owner, name));
      if (raw === undefined) return undefined;

      let combined: Uint8Array;
      let nonce: Uint8Array;
      let ciphertext: Uint8Array;
      try {
        combined = fromBase64(raw);
        if (combined.length < NONCE_BYTES + 16) {
          throw new Error("tampered");
        }
        nonce = combined.slice(0, NONCE_BYTES);
        ciphertext = combined.slice(NONCE_BYTES);
      } catch {
        throw new Error("Tamper detected: unable to parse stored secret.");
      }

      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: makeAAD(owner, name),
          },
          aesKey,
          ciphertext,
        );
        return dec.decode(plaintext);
      } catch {
        throw new Error(
          "Tamper detected: authentication tag verification failed.",
        );
      }
    },

    async list(owner: string): Promise<string[]> {
      const raw = await storage.get(indexKey(owner));
      if (raw === undefined) return [];
      const names: string[] = JSON.parse(raw);
      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const dKey = dataKey(owner, name);
      const raw = await storage.get(dKey);
      if (raw === undefined) return false;

      await storage.delete(dKey);

      // keep the index consistent
      const iKey = indexKey(owner);
      const idxRaw = await storage.get(iKey);
      if (idxRaw !== undefined) {
        const names: string[] = JSON.parse(idxRaw);
        const idx = names.indexOf(name);
        if (idx !== -1) names.splice(idx, 1);
        if (names.length === 0) {
          await storage.delete(iKey);
        } else {
          await storage.set(iKey, JSON.stringify(names));
        }
      }

      return true;
    },
  };
}
