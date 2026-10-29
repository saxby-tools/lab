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

  const SALT_KEY = "__ss_salt";
  const IDX_PREFIX = "__ss_idx_";
  const SEC_PREFIX = "__ss_sec_";

  // Load or create the PBKDF2 salt
  let saltHex = await storage.get(SALT_KEY);
  if (saltHex === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltHex = toHex(salt);
    await storage.set(SALT_KEY, saltHex);
  }
  const salt = fromHex(saltHex);

  // Derive a 256-bit AES-GCM key from the master password
  const aesKey = await deriveKey(masterPassword, salt);

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      enc.encode(input),
    );
    return toHex(new Uint8Array(digest));
  }

  async function indexKeyFor(owner: string): Promise<string> {
    return IDX_PREFIX + await sha256Hex("idx" + owner);
  }

  async function secretKeyFor(owner: string, name: string): Promise<string> {
    return SEC_PREFIX + await sha256Hex("sec" + owner + "\x00" + name);
  }

  async function readIndex(owner: string): Promise<string[]> {
    const raw = await storage.get(await indexKeyFor(owner));
    if (raw === undefined) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
      return [];
    } catch {
      return [];
    }
  }

  async function writeIndex(owner: string, names: string[]): Promise<void> {
    await storage.set(await indexKeyFor(owner), JSON.stringify(names));
  }

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = enc.encode(owner + "\x00" + name);
      const plaintext = enc.encode(value);

      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        plaintext,
      );

      // Store IV ‖ ciphertext (ciphertext includes the 16-byte GCM tag)
      const blob = new Uint8Array(12 + ct.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(ct), 12);

      const key = await secretKeyFor(owner, name);
      await storage.set(key, toHex(blob));

      // Update the owner's index
      const names = await readIndex(owner);
      if (!names.includes(name)) {
        names.push(name);
        await writeIndex(owner, names);
      }
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = await secretKeyFor(owner, name);
      const raw = await storage.get(key);
      if (raw === undefined) return undefined;

      try {
        const blob = fromHex(raw);
        const iv = blob.subarray(0, 12);
        const ct = blob.subarray(12);
        const aad = enc.encode(owner + "\x00" + name);

        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          aesKey,
          ct,
        );
        return dec.decode(pt);
      } catch {
        throw new Error("Decryption failed: secret may be tampered or password is wrong");
      }
    },

    async list(owner: string): Promise<string[]> {
      const names = await readIndex(owner);
      return names.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = await secretKeyFor(owner, name);
      const raw = await storage.get(key);
      if (raw === undefined) return false;

      await storage.delete(key);

      const names = await readIndex(owner);
      const filtered = names.filter((n) => n !== name);
      if (filtered.length !== names.length) {
        await writeIndex(owner, filtered);
      }

      return true;
    },
  };
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function toHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}
