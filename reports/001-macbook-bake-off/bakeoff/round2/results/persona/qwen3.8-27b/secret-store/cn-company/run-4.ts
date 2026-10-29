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

  const META_KEY = "__secret_store_meta__";
  const PBKDF2_ITERATIONS = 100_000;
  const SALT_LEN = 16;
  const IV_LEN = 12;
  const KEY_LEN = 256;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ── base64 helpers (binary ↔ string for the KV storage) ──

  function bufToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ── key derivation ──

  async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(masterPassword),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: KEY_LEN },
      false,
      ["encrypt", "decrypt"],
    );
  }

  // ── load or initialise metadata (salt + verification record) ──

  const metaRaw = await storage.get(META_KEY);
  let cryptoKey: CryptoKey;

  if (metaRaw !== undefined) {
    try {
      const meta = JSON.parse(metaRaw) as { salt: string; iv: string; ct: string };
      const salt = base64ToBytes(meta.salt);
      cryptoKey = await deriveKey(salt);

      // Verify that we hold the correct key by decrypting the canary.
      const iv = base64ToBytes(meta.iv);
      const ct = base64ToBytes(meta.ct);
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(META_KEY) },
        cryptoKey,
        ct,
      );
    } catch {
      throw new Error("Invalid master password");
    }
  } else {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    cryptoKey = await deriveKey(salt);

    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(META_KEY) },
      cryptoKey,
      encoder.encode("secret-store-verify"),
    );

    await storage.set(
      META_KEY,
      JSON.stringify({
        salt: bufToBase64(salt.buffer),
        iv: bufToBase64(iv.buffer),
        ct: bufToBase64(ct),
      }),
    );
  }

  // ── storage-key helpers ──
  //
  // Layout: secret:<ownerLen>:<owner>:<nameLen>:<name>
  //
  // Length-prefixed so that no (owner, name) pair can collide with
  // another even when the strings contain ':', '/', '|', spaces, etc.

  function storageKeyFor(owner: string, name: string): string {
    return `secret:${owner.length}:${owner}:${name.length}:${name}`;
  }

  function aadFor(owner: string, name: string): Uint8Array {
    return encoder.encode(storageKeyFor(owner, name));
  }

  // ── the SecretStore interface ──

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
        cryptoKey,
        encoder.encode(value),
      );
      const combined = new Uint8Array(IV_LEN + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), IV_LEN);
      await storage.set(storageKeyFor(owner, name), bufToBase64(combined.buffer));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const raw = await storage.get(storageKeyFor(owner, name));
      if (raw === undefined) return undefined;

      try {
        const data = base64ToBytes(raw);
        if (data.length < IV_LEN + 16) throw new Error("truncated");

        const iv = data.slice(0, IV_LEN);
        const ciphertext = data.slice(IV_LEN);
        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aadFor(owner, name) },
          cryptoKey,
          ciphertext,
        );
        return decoder.decode(decrypted);
      } catch {
        throw new Error("Tampering detected or decryption failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = `secret:${owner.length}:${owner}:`;
      const allKeys = await storage.keys();
      const names: string[] = [];

      for (const k of allKeys) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const colonIdx = rest.indexOf(":");
        if (colonIdx === -1) continue;

        const nameLen = Number.parseInt(rest.slice(0, colonIdx), 10);
        if (!Number.isInteger(nameLen)) continue;

        const name = rest.slice(colonIdx + 1);
        if (name.length === nameLen) {
          names.push(name);
        }
      }

      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const skey = storageKeyFor(owner, name);
      if (await storage.get(skey) === undefined) return false;
      await storage.delete(skey);
      return true;
    },
  };
}
