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

  // --- helpers ---
  function toHex(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, "0");
    }
    return s;
  }

  function fromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  async function sha256(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
    return toHex(digest);
  }

  async function secretKey(owner: string, name: string): Promise<string> {
    return "s/" + (await sha256(owner + "\0" + name));
  }

  async function indexKey(owner: string): Promise<string> {
    return "i/" + (await sha256(owner));
  }

  // --- derive key from master password ---
  const SALT_KEY = "__salt__";
  let saltHex = await storage.get(SALT_KEY);
  if (saltHex === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltHex = toHex(salt);
    await storage.set(SALT_KEY, saltHex);
  }
  const salt = fromHex(saltHex);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const key: CryptoKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- verify password via stored sentinel ---
  const VERIFY_KEY = "__verify__";
  const VERIFY_PLAINTEXT = "secret-store-verification-v1";

  const existingVerify = await storage.get(VERIFY_KEY);
  if (existingVerify !== undefined) {
    // Attempt to decrypt the sentinel; a wrong password will cause a failure.
    const dotIdx = existingVerify.indexOf(".");
    if (dotIdx < 0) throw new Error("Corrupted verification record");
    const iv = fromHex(existingVerify.slice(0, dotIdx));
    const ct = fromHex(existingVerify.slice(dotIdx + 1));
    try {
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(VERIFY_PLAINTEXT) },
        key,
        ct,
      );
    } catch {
      throw new Error("Invalid master password");
    }
  } else {
    // First initialisation – store a sentinel encrypted with this key.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: enc.encode(VERIFY_PLAINTEXT),
      },
      key,
      enc.encode(VERIFY_PLAINTEXT),
    );
    await storage.set(VERIFY_KEY, toHex(iv) + "." + toHex(ct));
  }

  // --- encrypt / decrypt helpers ---
  async function encryptValue(
    value: string,
    aad: string,
  ): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
      key,
      enc.encode(value),
    );
    return toHex(iv) + "." + toHex(ct);
  }

  async function decryptValue(
    stored: string,
    aad: string,
  ): Promise<string> {
    const dotIdx = stored.indexOf(".");
    if (dotIdx < 0) throw new Error("Corrupted secret data");
    const iv = fromHex(stored.slice(0, dotIdx));
    const ct = fromHex(stored.slice(dotIdx + 1));
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
        key,
        ct,
      );
      return dec.decode(pt);
    } catch {
      throw new Error("Tampered or invalid secret data");
    }
  }

  // --- public API ---
  const store: SecretStore = {
    async put(owner: string, name: string, value: string): Promise<void> {
      const aad = owner + "\0" + name;
      const sKey = await secretKey(owner, name);
      const blob = await encryptValue(value, aad);
      await storage.set(sKey, blob);

      // Update the owner index
      const iKey = await indexKey(owner);
      const raw = await storage.get(iKey);
      let names: string[] = [];
      if (raw !== undefined) {
        try {
          names = JSON.parse(raw) as string[];
        } catch {
          names = [];
        }
      }
      if (!names.includes(name)) {
        names.push(name);
      }
      await storage.set(iKey, JSON.stringify(names));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const sKey = await secretKey(owner, name);
      const blob = await storage.get(sKey);
      if (blob === undefined) return undefined;
      const aad = owner + "\0" + name;
      // Throws on tamper (GCM auth failure) – satisfies security goal.
      return decryptValue(blob, aad);
    },

    async list(owner: string): Promise<string[]> {
      const iKey = await indexKey(owner);
      const raw = await storage.get(iKey);
      if (raw === undefined) return [];
      let names: string[];
      try {
        names = JSON.parse(raw) as string[];
      } catch {
        return [];
      }
      // Filter out entries whose data has been deleted from storage
      const existing: string[] = [];
      for (const n of names) {
        const sKey = await secretKey(owner, n);
        const blob = await storage.get(sKey);
        if (blob !== undefined) {
          existing.push(n);
        }
      }
      return existing.sort();
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const sKey = await secretKey(owner, name);
      const blob = await storage.get(sKey);
      if (blob === undefined) return false;

      await storage.delete(sKey);

      // Remove from the owner index
      const iKey = await indexKey(owner);
      const raw = await storage.get(iKey);
      if (raw !== undefined) {
        let names: string[];
        try {
          names = JSON.parse(raw) as string[];
        } catch {
          names = [];
        }
        const filtered = names.filter((n) => n !== name);
        if (filtered.length > 0) {
          await storage.set(iKey, JSON.stringify(filtered));
        } else {
          await storage.delete(iKey);
        }
      }

      return true;
    },
  };

  return store;
}
