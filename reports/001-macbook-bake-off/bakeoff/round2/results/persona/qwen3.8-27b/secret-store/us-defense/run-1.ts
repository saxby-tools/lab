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
  const KDF_ITERATIONS = 210_000;
  const KDF_BITS = 256;
  const IV_BYTES = 12;

  // --- helpers ---

  function b64Encode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function b64Decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function dataKey(owner: string, name: string): string {
    return `d|${b64Encode(enc.encode(owner))}|${b64Encode(enc.encode(name))}`;
  }

  function indexKey(owner: string): string {
    return `i|${b64Encode(enc.encode(owner))}`;
  }

  function aad(owner: string, name: string): Uint8Array {
    const o = enc.encode(owner);
    const n = enc.encode(name);
    const buf = new Uint8Array(o.length + 1 + n.length);
    buf.set(o, 0);
    buf[o.length] = 0; // null separator
    buf.set(n, o.length + 1);
    return buf;
  }

  // --- key derivation ---

  let saltStr = await storage.get(SALT_KEY);
  if (saltStr === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltStr = b64Encode(salt);
    await storage.set(SALT_KEY, saltStr);
  }
  const salt = b64Decode(saltStr);

  const pbeKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: KDF_ITERATIONS, hash: "SHA-256" },
    pbeKey,
    { name: "AES-GCM", length: KDF_BITS },
    true,
    ["encrypt", "decrypt"],
  );

  // --- index helpers ---

  async function readIndex(owner: string): Promise<string[]> {
    const raw = await storage.get(indexKey(owner));
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
      return [];
    } catch {
      return [];
    }
  }

  async function addToIndex(owner: string, name: string): Promise<void> {
    const names = await readIndex(owner);
    const encoded = b64Encode(enc.encode(name));
    if (!names.includes(encoded)) {
      names.push(encoded);
      await storage.set(indexKey(owner), JSON.stringify(names));
    }
  }

  async function removeFromIndex(owner: string, name: string): Promise<void> {
    const names = await readIndex(owner);
    const encoded = b64Encode(enc.encode(name));
    const filtered = names.filter((n) => n !== encoded);
    if (filtered.length === 0) {
      await storage.delete(indexKey(owner));
    } else {
      await storage.set(indexKey(owner), JSON.stringify(filtered));
    }
  }

  // --- public API ---

  const store: SecretStore = {
    async put(owner, name, value) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(owner, name) },
        aesKey,
        enc.encode(value),
      );
      const record = JSON.stringify({
        iv: b64Encode(iv),
        ct: b64Encode(new Uint8Array(ct)),
      });
      await storage.set(dataKey(owner, name), record);
      await addToIndex(owner, name);
    },

    async get(owner, name) {
      const raw = await storage.get(dataKey(owner, name));
      if (raw === undefined) return undefined;

      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof (parsed as Record<string, unknown>).iv !== "string" ||
          typeof (parsed as Record<string, unknown>).ct !== "string"
        ) {
          throw new Error("malformed record");
        }
        const rec = parsed as { iv: string; ct: string };
        const iv = b64Decode(rec.iv);
        const ct = b64Decode(rec.ct);

        const pt = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad(owner, name) },
          aesKey,
          ct,
        );
        return dec.decode(pt);
      } catch (e) {
        throw new Error("Unable to decrypt secret: integrity check failed");
      }
    },

    async list(owner) {
      const names = await readIndex(owner);
      const decoded = names.map((n) => dec.decode(b64Decode(n)));
      decoded.sort();
      return decoded;
    },

    async remove(owner, name) {
      const key = dataKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;
      await storage.delete(key);
      await removeFromIndex(owner, name);
      return true;
    },
  };

  return store;
}
