// In-memory LRU cache with per-entry TTL expiry.

const DEFAULT_NOW = Date.now;

interface Entry<V> {
  value: V;
  expiry: number | null;
}

export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

export class LruCache<K, V> {
  #max: number;
  #defaultTtl: number | null;
  #clock: () => number;
  #store: Map<K, Entry<V>>;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;

    if (!Number.isInteger(maxEntries)) {
      throw new RangeError(
        `maxEntries must be an integer >= 1, got ${maxEntries}`,
      );
    }
    if (maxEntries < 1) {
      throw new RangeError(
        `maxEntries must be an integer >= 1, got ${maxEntries}`,
      );
    }

    let resolvedTtl: number | null = null;

    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs)) {
        throw new RangeError(
          `ttlMs must be a finite number > 0, got ${ttlMs}`,
        );
      }
      if (ttlMs <= 0) {
        throw new RangeError(
          `ttlMs must be a finite number > 0, got ${ttlMs}`,
        );
      }
      resolvedTtl = ttlMs;
    }

    this.#max = maxEntries;
    this.#defaultTtl = resolvedTtl;
    this.#clock = now ?? DEFAULT_NOW;
    this.#store = new Map<K, Entry<V>>();
  }

  // An entry with null expiry never expires.
  #isLive(entry: Entry<V>, t: number): boolean {
    if (entry.expiry === null) {
      return true;
    }
    return t < entry.expiry;
  }

  // Remove every entry whose TTL has lapsed.
  #purgeExpired(): void {
    const t = this.#clock();

    for (const [key, entry] of this.#store) {
      if (!this.#isLive(entry, t)) {
        this.#store.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.#store.get(key);
    if (entry === undefined) {
      return undefined;
    }

    const t = this.#clock();

    if (!this.#isLive(entry, t)) {
      this.#store.delete(key);
      return undefined;
    }

    // Re-insert to mark as most-recently-used.
    this.#store.delete(key);
    this.#store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs)) {
        throw new RangeError(
          `ttlMs must be a finite number > 0, got ${ttlMs}`,
        );
      }
      if (ttlMs <= 0) {
        throw new RangeError(
          `ttlMs must be a finite number > 0, got ${ttlMs}`,
        );
      }
    }

    const t = this.#clock();
    const ttl = ttlMs ?? this.#defaultTtl;
    const expiry = ttl !== null ? t + ttl : null;

    const existing = this.#store.get(key);

    if (existing !== undefined) {
      if (this.#isLive(existing, t)) {
        // Replace in place; no eviction for an existing key.
        this.#store.delete(key);
        this.#store.set(key, { value, expiry });
        return this;
      }
      // Expired: treat as absent.
      this.#store.delete(key);
    }

    // New key — evict if the cache is at capacity.
    if (this.#store.size >= this.#max) {
      this.#purgeExpired();
      if (this.#store.size >= this.#max) {
        // Evict the least-recently-used live entry.
        for (const k of this.#store.keys()) {
          this.#store.delete(k);
          break;
        }
      }
    }

    this.#store.set(key, { value, expiry });
    return this;
  }

  has(key: K): boolean {
    const entry = this.#store.get(key);
    if (entry === undefined) {
      return false;
    }

    const t = this.#clock();

    if (!this.#isLive(entry, t)) {
      this.#store.delete(key);
      return false;
    }

    // Intentionally does not update recency.
    return true;
  }

  delete(key: K): boolean {
    const entry = this.#store.get(key);
    if (entry === undefined) {
      return false;
    }

    const t = this.#clock();

    if (!this.#isLive(entry, t)) {
      // Clean up the stale slot but report "not found".
      this.#store.delete(key);
      return false;
    }

    this.#store.delete(key);
    return true;
  }

  clear(): void {
    this.#store.clear();
  }

  get size(): number {
    this.#purgeExpired();
    return this.#store.size;
  }

  keys(): K[] {
    this.#purgeExpired();
    // Map iterates LRU → MRU; callers expect MRU → LRU.
    return [...this.#store.keys()].reverse();
  }
}
