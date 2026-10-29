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

export function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ── helpers ────────────────────────────────────────────────────── */

  const toB64 = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };

  const fromB64 = (s: string): Uint8Array => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  // Storage key layout:  secret:<base64(owner)>|<base64(name)>
  // '|' is safe because base64 output is [A-Za-z0-9+/=] which excludes '|'.
  const keyFor = (owner: string, name: string): string =>
    `secret:${toB64(enc.encode(owner))}|${toB64(enc.encode(name))}`;

  const prefixFor = (owner: string): string =>
    `secret:${toB64(enc.encode(owner))}|`;

  // AAD binds the ciphertext to (owner, name) so that copying one secret's
  // blob onto another's key will fail authentication.
  // Layout: [ownerLen: u32 BE][nameLen: u32 BE][ownerBytes][nameBytes]
  const aadFor = (owner: string, name: string): Uint8Array => {
    const ob = enc.encode(owner);
    const nb = enc.encode(name);
    const buf = new Uint8Array(8 + ob.length + nb.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, ob.length);
    dv.setUint32(4, nb.length);
    buf.set(ob, 8);
    buf.set(nb, 8 + ob.length);
    return buf;
  };

  const deriveKey = (salt: Uint8Array): Promise<CryptoKey> => {
    const km = crypto.subtle.importKey(
      "raw",
      enc.encode(masterPassword),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return km.then((material) =>
      crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: 100_000,
          hash: "SHA-256",
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )
    );
  };

  /* ── store implementation ───────────────────────────────────────── */

  const store: SecretStore = {
    async put(owner, name, value) {
      const sk = keyFor(owner, name);
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aesKey = await deriveKey(salt);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
        aesKey,
        enc.encode(value),
      );
      const entry = JSON.stringify({
        s: toB64(salt),
        i: toB64(iv),
        c: toB64(new Uint8Array(ct)),
      });
      await storage.set(sk, entry);
    },

    async get(owner, name) {
      const sk = keyFor(owner, name);
      const raw = await storage.get(sk);
      if (raw === undefined) return undefined;
      try {
        const p = JSON.parse(raw) as { s: string; i: string; c: string };
        const aesKey = await deriveKey(fromB64(p.s));
        const pt = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: fromB64(p.i),
            additionalData: aadFor(owner, name),
          },
          aesKey,
          fromB64(p.c),
        );
        return dec.decode(pt);
      } catch {
        throw new Error("Secret access failed");
      }
    },

    async list(owner) {
      const prefix = prefixFor(owner);
      const allKeys = await storage.keys();
      const names = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => dec.decode(fromB64(k.slice(prefix.length))));
      names.sort();
      return names;
    },

    async remove(owner, name) {
      const sk = keyFor(owner, name);
      if (await storage.get(sk) === undefined) return false;
      await storage.delete(sk);
      return true;
    },
  };

  return Promise.resolve(store);
}
