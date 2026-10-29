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

  // Derive a 256-bit AES-GCM key from the master password.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("secret-store-salt-v1"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  // --- helpers ---------------------------------------------------------------

  function b64urlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function storageKey(owner: string, name: string): string {
    return `secret/${b64urlEncode(enc.encode(owner))}/${b64urlEncode(enc.encode(name))}`;
  }

  function ownerPrefix(owner: string): string {
    return `secret/${b64urlEncode(enc.encode(owner))}/`;
  }

  // --- store -----------------------------------------------------------------

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = storageKey(owner, name);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const aad = enc.encode(key);
      const plaintext = enc.encode(value);

      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", nonce, additionalData: aad },
        aesKey,
        plaintext,
      );

      // Layout: [12-byte nonce][ciphertext + 16-byte GCM tag]
      const blob = new Uint8Array(12 + ct.byteLength);
      blob.set(nonce, 0);
      blob.set(new Uint8Array(ct), 12);

      await storage.set(key, b64urlEncode(blob));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = storageKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      let blob: Uint8Array;
      try {
        blob = b64urlDecode(stored);
      } catch {
        throw new Error("Corrupted secret data");
      }

      if (blob.length < 28) {
        throw new Error("Corrupted secret data");
      }

      const nonce = blob.slice(0, 12);
      const ciphertext = blob.slice(12);
      const aad = enc.encode(key);

      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", nonce, additionalData: aad },
          aesKey,
          ciphertext,
        );
        return dec.decode(plain);
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
          const namePart = k.slice(prefix.length);
          try {
            names.push(dec.decode(b64urlDecode(namePart)));
          } catch {
            // Skip keys with a malformed name component.
          }
        }
      }

      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = storageKey(owner, name);
      const existing = await storage.get(key);
      if (existing === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}
