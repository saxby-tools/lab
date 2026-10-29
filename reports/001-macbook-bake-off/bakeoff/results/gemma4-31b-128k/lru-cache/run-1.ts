export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiry: number | null;
}

export class LruCache<K, V> {
  private readonly options: CacheOptions;
  private readonly cache = new Map<K, CacheEntry<V>>();
  private readonly now: () => number;

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }
    if (
      options.ttlMs !== undefined &&
      (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
    ) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /**
   * Checks if an entry is expired. 
   * If the entry is expired, it is removed from the cache.
   * Returns true if the entry is expired or doesn't exist.
   */
  private isExpired(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return true;
    if (entry.expiry === null) return false;

    if (this.now() >= entry.expiry) {
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  get(key: K): V | undefined {
    if (this.isExpired(key)) {
      return undefined;
    }

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Map maintains insertion order. To move to the "most recently used" 
    // position, we delete and re-insert the entry.
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (
      ttlMs !== undefined &&
      (!Number.isFinite(ttlMs) || ttlMs <= 0)
    ) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    const isLive = this.cache.has(key) && !this.isExpired(key);

    if (isLive) {
      // Replacing an existing live key: remove it to reset recency.
      this.cache.delete(key);
    } else {
      // New key or existing key that has expired.
      // First, remove all expired entries from the cache.
      for (const k of this.cache.keys()) {
        this.isExpired(k);
      }

      // If the cache is still full, evict the least recently used (the first key).
      if (this.cache.size >= this.options.maxEntries) {
        const lruKey = this.cache.keys().next().value;
        if (lruKey !== undefined) {
          this.cache.delete(lruKey);
        }
      }
    }

    const ttl = ttlMs ?? this.options.ttlMs;
    const expiry = ttl !== undefined ? this.now() + ttl : null;

    this.cache.set(key, { value, expiry });

    return this;
  }

  has(key: K): boolean {
    // has must not change recency. isExpired prunes but doesn't move.
    return !this.isExpired(key) && this.cache.has(key);
  }

  delete(key: K): boolean {
    if (this.isExpired(key)) {
      return false;
    }
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    let count = 0;
    for (const k of this.cache.keys()) {
      if (!this.isExpired(k)) {
        count++;
      }
    }
    return count;
  }

  keys(): K[] {
    const liveKeys: K[] = [];
    for (const k of this.cache.keys()) {
      if (!this.isExpired(k)) {
        liveKeys.push(k);
      }
    }
    // Map order is LRU to MRU. Return MRU to LRU.
    return liveKeys.reverse();
  }
}
