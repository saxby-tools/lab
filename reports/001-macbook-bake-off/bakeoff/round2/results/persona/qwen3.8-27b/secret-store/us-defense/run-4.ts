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

  const META_KEY = "\0__kdf_meta__\0";
  const ITERATIONS = 100_000;
  const SALT_LEN = 32;
  const IV_LEN = 12;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // --- helpers ---

  function toHex(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i]!.toString(16).padStart(2, "0");
    }
    return s;
  }

  function fromHex(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function bytesToB64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]!);
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

  function storageKey(owner: string, name: string): string {
    return "secret:" + toHex(enc.encode(owner)) + "|" + toHex(enc.encode(name));
  }

  function ownerPrefix(owner: string): string {
    return "secret:" + toHex(enc.encode(owner)) + "|";
  }

  // --- KDF metadata ---

  let metaRaw = await storage.get(META_KEY);
  let salt: Uint8Array;
  let iterations: number;

  if (metaRaw !== undefined) {
    try {
      const meta = JSON.parse(metaRaw) as { s: string; i: number };
      salt = b64ToBytes(meta.s);
      iterations = meta.i;
    } catch {
      throw new Error("Corrupted key derivation metadata");
    }
  } else {
    salt = new Uint8Array(SALT_LEN);
    crypto.getRandomValues(salt);
    iterations = ITERATIONS;
    const meta = JSON.stringify({ s: bytesToB64(salt), i: iterations });
    await storage.set(META_KEY, meta);
  }

  // --- derive AES-GCM key from master password ---

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey: CryptoKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- public API ---

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = storageKey(owner, name);
      const iv = new Uint8Array(IV_LEN);
      crypto.getRandomValues(iv);

      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: enc.encode(key) },
        aesKey,
        enc.encode(value),
      );

      const blob = new Uint8Array(iv.length + ciphertext.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(key, bytesToB64(blob));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = storageKey(owner, name);
      const raw = await storage.get(key);
      if (raw === undefined) return undefined;

      let blob: Uint8Array;
      try {
        blob = b64ToBytes(raw);
      } catch {
        throw new Error("Integrity check failed");
      }

      if (blob.length < IV_LEN + 16) {
        throw new Error("Integrity check failed");
      }

      const iv = blob.slice(0, IV_LEN);
      const ct = blob.slice(IV_LEN);

      try {
        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: enc.encode(key) },
          aesKey,
          ct,
        );
        return dec.decode(pt);
      } catch {
        throw new Error("Integrity check failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = ownerPrefix(owner);
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const nameHex = k.slice(prefix.length);
          if (nameHex.length > 0 && nameHex.length % 2 === 0) {
            try {
              names.push(dec.decode(fromHex(nameHex)));
            } catch {
              // skip malformed keys
            }
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKey(owner, name);
      const raw = await storage.get(key);
      if (raw === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
