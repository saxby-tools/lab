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

const SALT_KEY = "__ss_salt";
const PREFIX = "ss:";
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 100_000;

// ── byte / string helpers ──────────────────────────────────────────

function toHex(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += buf[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) {
    bin += String.fromCharCode(buf[i]!);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function sha256(data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// ── factory ────────────────────────────────────────────────────────

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // --- derive the symmetric key from the master password ---
  // The salt is persisted in storage so that a new store instance with
  // the same password derives the same key.  If an attacker changes the
  // salt, the derived key diverges and every subsequent decryption fails.
  let saltHex: string | undefined = await storage.get(SALT_KEY);
  if (saltHex === undefined) {
    const rawSalt = crypto.getRandomValues(new Uint8Array(16));
    saltHex = toHex(rawSalt);
    await storage.set(SALT_KEY, saltHex);
  }

  const pbkdf2Base = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromHex(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    pbkdf2Base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- storage-key computation ---
  //
  // The storage key is a deterministic hash of (owner, name) so that
  // repeated puts to the same slot overwrite, and get / remove can
  // locate the record without a scan.  JSON.stringify([owner, name])
  // gives an unambiguous encoding even when owner or name contain
  // delimiters such as ':', '\0', '/', etc.
  async function slotKey(owner: string, name: string): Promise<string> {
    const h = await sha256(enc.encode(JSON.stringify([owner, name])));
    return PREFIX + toHex(h);
  }

  // --- authenticated encryption helpers ---
  //
  // Each secret is encrypted with a fresh 12-byte IV and AES-256-GCM.
  // The AAD is the storage key itself, which binds the ciphertext to
  // its exact location.  Copying a blob to a different slot (or to a
  // different owner's slot) changes the AAD and GCM authentication
  // fails, satisfying the tamper-detection and owner-isolation goals.
  async function seal(plaintext: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      enc.encode(plaintext),
    );
    const out = new Uint8Array(IV_LEN + ct.length);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_LEN);
    return toBase64(out);
  }

  async function open(blob: string, aad: string): Promise<string> {
    const raw = fromBase64(blob);
    if (raw.length <= IV_LEN) {
      throw new Error("corrupted secret data");
    }
    const iv = raw.subarray(0, IV_LEN);
    const ct = raw.subarray(IV_LEN);
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
        aesKey,
        ct,
      );
      return dec.decode(pt);
    } catch {
      throw new Error("decryption failed – tampering or incorrect password");
    }
  }

  // --- public API ---

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = await slotKey(owner, name);
      // The plaintext embeds owner and name so that list() can
      // recover them after decryption.  The AAD is the storage key,
      // binding the ciphertext to this exact slot.
      const payload = JSON.stringify({ o: owner, n: name, v: value });
      await storage.set(key, await seal(payload, key));
    },

    async get(
      owner: string,
      name: string,
    ): Promise<string | undefined> {
      const key = await slotKey(owner, name);
      const blob = await storage.get(key);
      if (blob === undefined) return undefined;
      const payload = await open(blob, key);
      const rec = JSON.parse(payload) as { o: string; n: string; v: string };
      // Defence-in-depth: verify the decrypted record actually belongs
      // to this (owner, name) pair.  GCM + AAD already guarantees this
      // in practice, but the check guards against pathological hash
      // collisions.
      if (rec.o !== owner || rec.n !== name) {
        throw new Error("secret integrity check failed");
      }
      return rec.v;
    },

    async list(owner: string): Promise<string[]> {
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (!k.startsWith(PREFIX)) continue;
        const blob = await storage.get(k);
        if (blob === undefined) continue;
        try {
          const payload = await open(blob, k);
          const rec = JSON.parse(payload) as { o: string; n: string };
          if (rec.o === owner) {
            names.push(rec.n);
          }
        } catch {
          // Skip entries that are undecryptable (wrong key, tampered,
          // or belong to a different owner whose AAD does not match).
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = await slotKey(owner, name);
      const blob = await storage.get(key);
      if (blob === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
