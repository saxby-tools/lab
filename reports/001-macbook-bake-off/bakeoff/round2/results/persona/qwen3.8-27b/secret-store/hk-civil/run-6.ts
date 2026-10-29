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

const PREFIX = "secret-store:";
const SALT = "secret-store-v1-salt";

function bytesToBase64(bytes: Uint8Array): string {
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

function makeKey(owner: string, name: string): string {
  return `${PREFIX}${owner.length}:${owner}${name.length}:${name}`;
}

function parseKey(storageKey: string): { owner: string; name: string } | null {
  if (!storageKey.startsWith(PREFIX)) return null;
  const rest = storageKey.slice(PREFIX.length);

  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return null;

  const ownerLen = parseInt(rest.slice(0, firstColon), 10);
  if (Number.isNaN(ownerLen) || ownerLen < 1) return null;

  const ownerStart = firstColon + 1;
  const ownerEnd = ownerStart + ownerLen;
  if (ownerEnd > rest.length) return null;

  const owner = rest.slice(ownerStart, ownerEnd);
  if (owner.length !== ownerLen) return null;

  const afterOwner = ownerEnd;
  const secondColon = rest.indexOf(":", afterOwner);
  if (secondColon <= afterOwner) return null;

  const nameLen = parseInt(rest.slice(afterOwner, secondColon), 10);
  if (Number.isNaN(nameLen) || nameLen < 1) return null;

  const nameStart = secondColon + 1;
  const nameEnd = nameStart + nameLen;
  if (nameEnd > rest.length) return null;

  const name = rest.slice(nameStart, nameEnd);
  if (name.length !== nameLen) return null;

  return { owner, name };
}

export async function createSecretStore(
  options: SecretStoreOptions,
): Promise<SecretStore> {
  const { storage, masterPassword } = options;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Derive a 256-bit AES-GCM key from the master password via PBKDF2.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(SALT),
      iterations: 100_000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  async function put(owner: string, name: string, value: string): Promise<void> {
    const keyStr = makeKey(owner, name);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = enc.encode(keyStr);
    const plaintext = enc.encode(value);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plaintext,
    );

    // Layout: [12-byte IV][ciphertext + 16-byte GCM tag]
    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), 12);

    await storage.set(keyStr, bytesToBase64(combined));
  }

  async function get(owner: string, name: string): Promise<string | undefined> {
    const keyStr = makeKey(owner, name);
    const stored = await storage.get(keyStr);
    if (stored === undefined) return undefined;

    try {
      const combined = base64ToBytes(stored);
      if (combined.length < 28) throw new Error("Ciphertext too short");

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const aad = enc.encode(keyStr);

      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        ciphertext,
      );

      return dec.decode(plaintext);
    } catch {
      throw new Error("Failed to decrypt secret: possible tampering or incorrect password");
    }
  }

  async function list(owner: string): Promise<string[]> {
    const allKeys = await storage.keys();
    const names: string[] = [];
    for (const k of allKeys) {
      const parsed = parseKey(k);
      if (parsed !== null && parsed.owner === owner) {
        names.push(parsed.name);
      }
    }
    names.sort();
    return names;
  }

  async function remove(owner: string, name: string): Promise<boolean> {
    const keyStr = makeKey(owner, name);
    const existing = await storage.get(keyStr);
    if (existing === undefined) return false;
    await storage.delete(keyStr);
    return true;
  }

  return { put, get, list, remove };
}
