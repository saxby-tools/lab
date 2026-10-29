// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_NOW: () => number = Date.now;


// ── Validation helpers ───────────────────────────────────────────────────

function assertMaxEntries(value: unknown): number {
  if (typeof value !== "number") {
    throw new RangeError(
      "maxEntries must be an integer of 1 or more",
    );
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      "maxEntries must be an integer of 1 or more",
    );
  }
  return value;
}

function assertTtl(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new RangeError(
      `${label} must be a finite number greater than 0`,
    );
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `${label} must be a finite number greater than 0`,
    );
  }
  return value;
}


// ── Types ────────────────────────────────────────────────────────────────

export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  // null means "never expires"
  expiresAt: number | null;
}


// ── LRU cache ────────────────────────────────────────────────────────────
//
// A Map backs the store because its iteration order tracks insertion order,
// giving O(1) LRU bookkeeping: first key is LRU, last is MRU.  "Touching"
// an entry (delete + re-insert) moves it to the MRU end.

export class LruCache<K, V> {
  private readonly maxEntries: number;
  private readonly defaultTtl: number | null;
  private readonly clock: () => number;
  private readonly store: Map<K, Entry<V>>;

  constructor(options: CacheOptions) {
    this.maxEntries = assertMaxEntries(options.maxEntries);

    let ttl: number | null = null;
    if (options.ttlMs !== undefined) {
      ttl = assertTtl(options.ttlMs, "ttlMs");
    }
    this.defaultTtl = ttl;

    this.clock = options.now ?? DEFAULT_NOW;
    this.store = new Map();
  }

  // ── Public API ────────────────────────────────────────────────────────

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    // Promote to most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    let ttl: number | null = null;
    if (ttlMs !== undefined) {
      ttl = assertTtl(ttlMs, "ttlMs");
    }
    if (ttl === null && this.defaultTtl !== null) {
      ttl = this.defaultTtl;
    }

    let expiresAt: number | null = null;
    if (ttl !== null) {
      expiresAt = this.clock() + ttl;
    }
    const entry: Entry<V> = { value, expiresAt };

    // Replacing an existing key never evicts; refresh + touch.
    if (this.store.has(key)) {
      this.store.delete(key);
      this.store.set(key, entry);
      return this;
    }

    // New key: purge expired first, then evict LRU if still full.
    this.purgeExpired();

    if (this.store.size >= this.maxEntries) {
      const lruKey = this.store.keys().next().value;
      this.store.delete(lruKey);
    }

    this.store.set(key, entry);
    return this;
  }

  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) {
      return false;
    }
    // An expired entry is "as if absent", so deletion returns false.
    const wasLive = !this.isExpired(entry);
    this.store.delete(key);
    return wasLive;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    let count = 0;
    for (const entry of this.store.values()) {
      if (!this.isExpired(entry)) {
        count++;
      }
    }
    return count;
  }

  keys(): K[] {
    // Map iterates LRU → MRU; spec wants MRU → LRU.
    const live: K[] = [];
    for (const [key, entry] of this.store) {
      if (!this.isExpired(entry)) {
        live.push(key);
      }
    }
    return live.reverse();
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private isExpired(entry: Entry<V>): boolean {
    if (entry.expiresAt === null) {
      return false;
    }
    return this.clock() >= entry.expiresAt;
  }

  private purgeExpired(): void {
    // Safe: Map iterators tolerate concurrent deletion of visited keys.
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      }
    }
  }
}
