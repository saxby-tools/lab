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

  const SALT_KEY = "\x00__ss_salt__";
  const CHECK_KEY = "\x00__ss_check__";
  const SECRET_PREFIX = "\x00__ss_secret__\x00";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bytesToB64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function b64ToBytes(s: string): Uint8Array {
    const binary = atob(s);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function encodeComponent(s: string): string {
    return bytesToB64(encoder.encode(s));
  }

  function decodeComponent(s: string): string {
    return decoder.decode(b64ToBytes(s));
  }

  function makeKey(owner: string, name: string): string {
    return SECRET_PREFIX + encodeComponent(owner) + "|" + encodeComponent(name);
  }

  function makeAad(owner: string, name: string): Uint8Array {
    const ownerBytes = encoder.encode(owner);
    const nameBytes = encoder.encode(name);
    const aad = new Uint8Array(8 + ownerBytes.length + nameBytes.length);
    const view = new DataView(aad.buffer);
    view.setUint32(0, ownerBytes.length, true);
    view.setUint32(4, nameBytes.length, true);
    aad.set(ownerBytes, 8);
    aad.set(nameBytes, 8 + ownerBytes.length);
    return aad;
  }

  // --- Key derivation ---

  let salt: Uint8Array;
  const existingSaltB64 = await storage.get(SALT_KEY);
  if (existingSaltB64 !== undefined) {
    salt = b64ToBytes(existingSaltB64);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(32));
    await storage.set(SALT_KEY, bytesToB64(salt));
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- Verify or initialise the check entry ---

  const existingCheckB64 = await storage.get(CHECK_KEY);

  if (existingCheckB64 !== undefined) {
    try {
      const data = b64ToBytes(existingCheckB64);
      if (data.length < 13) throw new Error("corrupt check");
      const iv = data.subarray(0, 12);
      const ct = data.subarray(12);
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        derivedKey,
        ct,
      );
    } catch {
      throw new Error("Invalid master password");
    }
  } else if (existingSaltB64 === undefined) {
    // Fresh store – create the verification entry.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      derivedKey,
      encoder.encode("__secretstore_check__"),
    );
    const blob = new Uint8Array(12 + ct.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ct), 12);
    await storage.set(CHECK_KEY, bytesToB64(blob));
  }

  // --- Public API ---

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = makeKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = makeAad(owner, name);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        derivedKey,
        encoder.encode(value),
      );
      const blob = new Uint8Array(12 + ct.byteLength);
      blob.set(iv, 0);
      blob.set(new Uint8Array(ct), 12);
      await storage.set(key, bytesToB64(blob));
    },

    async get(
      owner: string,
      name: string,
    ): Promise<string | undefined> {
      const key = makeKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      try {
        const data = b64ToBytes(stored);
        if (data.length < 13) throw new Error("corrupt secret data");
        const iv = data.subarray(0, 12);
        const ct = data.subarray(12);
        const aad = makeAad(owner, name);
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          derivedKey,
          ct,
        );
        return decoder.decode(plain);
      } catch (e) {
        if (e instanceof Error && e.message === "corrupt secret data") throw e;
        throw new Error("Secret verification failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = SECRET_PREFIX + encodeComponent(owner) + "|";
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          const nameEncoded = k.slice(prefix.length);
          names.push(decodeComponent(nameEncoded));
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = makeKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
