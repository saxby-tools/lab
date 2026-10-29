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

const SALT_KEY = "meta.salt";
const SECRET_PREFIX = "sk.";
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;

  // Retrieve or generate the PBKDF2 salt
  let saltB64: string | undefined = await storage.get(SALT_KEY);
  if (saltB64 === undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    saltB64 = toBase64(salt);
    await storage.set(SALT_KEY, saltB64);
  }
  const salt = fromBase64(saltB64);

  // Derive a unique AES-256 key from the master password and salt
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterPassword),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    async put(owner: string, name: string, value: string): Promise<void> {
      const key = makeKey(owner, name);
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const aad = makeAad(owner, name);
      const plaintext = new TextEncoder().encode(value);

      const ciphertext: ArrayBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        aesKey,
        plaintext,
      );

      // Layout: iv (12 bytes) || ciphertext+tag (n + 16 bytes)
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);

      await storage.set(key, toBase64(combined));
    },

    async get(owner: string, name: string): Promise<string | undefined> {
      const key = makeKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;

      let data: Uint8Array;
      try {
        data = fromBase64(stored);
      } catch {
        throw new Error("Corrupted secret data");
      }

      if (data.length < IV_LENGTH + TAG_LENGTH) {
        throw new Error("Corrupted secret data");
      }

      const iv = data.slice(0, IV_LENGTH);
      const ciphertext = data.slice(IV_LENGTH);
      const aad = makeAad(owner, name);

      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          aesKey,
          ciphertext,
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        throw new Error("Secret integrity check failed");
      }
    },

    async list(owner: string): Promise<string[]> {
      const prefix = SECRET_PREFIX + toBase64(new TextEncoder().encode(owner)) + ".";
      const allKeys = await storage.keys();
      const names: string[] = [];
      for (const k of allKeys) {
        if (k.startsWith(prefix)) {
          try {
            names.push(new TextDecoder().decode(fromBase64(k.slice(prefix.length))));
          } catch {
            // Skip malformed entries that cannot be decoded
          }
        }
      }
      names.sort();
      return names;
    },

    async remove(owner: string, name: string): Promise<boolean> {
      const key = makeKey(owner, name);
      const stored = await storage.get(key);
      if (stored === undefined) return false;
      await storage.delete(key);
      return true;
    },
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a storage key that is unique for each (owner, name) pair.
 * Owner and name are base64-encoded so that any character (including ':', '/',
 * '|', whitespace, newlines) is safely embedded.  The '.' separator never
 * appears in standard base64 output, so the split is unambiguous.
 */
function makeKey(owner: string, name: string): string {
  return (
    SECRET_PREFIX +
    toBase64(new TextEncoder().encode(owner)) +
    "." +
    toBase64(new TextEncoder().encode(name))
  );
}

/**
 * Additional Authenticated Data for AES-GCM.  Binding the owner and name
 * (with explicit byte-length prefixes to avoid any ambiguity) into the
 * ciphertext ensures that an attacker cannot copy one secret's blob to
 * another (owner, name) slot and have it decrypt successfully.
 */
function makeAad(owner: string, name: string): Uint8Array {
  const ownerBytes = new TextEncoder().encode(owner);
  const nameBytes = new TextEncoder().encode(name);
  const total = 4 + ownerBytes.length + 4 + nameBytes.length;
  const aad = new Uint8Array(total);
  const view = new DataView(aad.buffer);
  view.setUint32(0, ownerBytes.length);
  aad.set(ownerBytes, 4);
  view.setUint32(4 + ownerBytes.length, nameBytes.length);
  aad.set(nameBytes, 8 + ownerBytes.length);
  return aad;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
