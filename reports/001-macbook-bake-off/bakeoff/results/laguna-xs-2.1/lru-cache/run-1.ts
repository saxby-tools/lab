/**
 * LRU cache with expiry support.
 * Holds maxEntries items, evicts least recently used when full,
 * and entries can expire after TTL.
 */
export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

type Entry<V> = {
  value: V;
  expiry: number | null;
  lastAccessed: number;
};

export class LruCache<K, V> {
  private entries: Map<K, Entry<V>> = new Map();
  private usageOrder: K[] = [];
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | null;
  private readonly nowFn: () => number;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;

    // Validate maxEntries
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be an integer >= 1');
    }

    // Validate ttlMs if provided
    if (ttlMs !== undefined) {
      if (
        typeof ttlMs !== 'number' ||
        !Number.isFinite(ttlMs) ||
        ttlMs <= 0
      ) {
        throw new RangeError('ttlMs must be a finite number > 0');
      }
    }

    this.maxEntries = maxEntries;
    this.defaultTtlMs = ttlMs ?? null;
    this.nowFn = now ?? (() => Date.now());
  }

  /**
   * Internal: remove expired entries from the cache.
   */
  private removeExpired(): void {
    const now = this.nowFn();
    for (const [key, entry] of this.entries) {
      if (entry.expiry !== null && now >= entry.expiry) {
        this.entries.delete(key);
        this.usageOrder = this.usageOrder.filter(k => k !== key);
      }
    }
  }

  /**
   * Internal: evict the least recently used entry.
   */
  private evictLRU(): void {
    const lruKey = this.usageOrder[0];
    if (lruKey !== undefined) {
      this.entries.delete(lruKey);
      this.usageOrder.shift();
    }
  }

  /**
   * Internal: mark a key as most recently used.
   */
  private markUsed(key: K): void {
    const index = this.usageOrder.indexOf(key);
    if (index !== -1) {
      this.usageOrder.splice(index, 1);
    }
    this.usageOrder.push(key);
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the entry does not exist or has expired.
   * Marks the entry as most recently used if it exists and is live.
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    const now = this.nowFn();
    if (entry.expiry !== null && now >= entry.expiry) {
      // Entry has expired
      this.entries.delete(key);
      this.usageOrder = this.usageOrder.filter(k => k !== key);
      return undefined;
    }

    // Mark as most recently used
    this.markUsed(key);

    return entry.value;
  }

  /**
   * Set a value in the cache.
   * If the key already exists, it is replaced and becomes most recently used.
   * If the cache is full, evict expired entries first, then the LRU entry.
   * Returns this for chaining.
   */
  set(key: K, value: V, ttlMs?: number): this {
    // Validate ttlMs if provided
    if (ttlMs !== undefined) {
      if (
        typeof ttlMs !== 'number' ||
        !Number.isFinite(ttlMs) ||
        ttlMs <= 0
      ) {
        throw new RangeError('ttlMs must be a finite number > 0');
      }
    }

    const now = this.nowFn();
    const expiry = ttlMs !== undefined
      ? now + ttlMs
      : this.defaultTtlMs !== null
          ? now + this.defaultTtlMs
          : null;

    const isNewKey = !this.entries.has(key);

    // If replacing an existing key, just update it
    if (!isNewKey) {
      const existing = this.entries.get(key)!;
      this.entries.delete(key);
      this.usageOrder = this.usageOrder.filter(k => k !== key);
    }

    // Check if we need to evict
    if (isNewKey && this.entries.size >= this.maxEntries) {
      // First, remove expired entries
      this.removeExpired();

      // If still full, evict LRU
      if (this.entries.size >= this.maxEntries) {
        this.evictLRU();
      }
    }

    // Add the new entry
    this.entries.set(key, {
      value,
      expiry,
      lastAccessed: now,
    });
    this.usageOrder.push(key);

    return this;
  }

  /**
   * Check if a live entry exists for the given key.
   * Does not change recency.
   */
  has(key: K): boolean {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return false;
    }

    const now = this.nowFn();
    if (entry.expiry !== null && now >= entry.expiry) {
      return false;
    }

    return true;
  }

  /**
   * Delete an entry from the cache.
   * Returns true if a live entry was removed, false otherwise.
   */
  delete(key: K): boolean {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return false;
    }

    const now = this.nowFn();
    if (entry.expiry !== null && now >= entry.expiry) {
      // Already expired, but still count as removed
      this.entries.delete(key);
      this.usageOrder = this.usageOrder.filter(k => k !== key);
      return true;
    }

    this.entries.delete(key);
    this.usageOrder = this.usageOrder.filter(k => k !== key);
    return true;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.entries.clear();
    this.usageOrder = [];
  }

  /**
   * Get the number of live entries in the cache.
   */
  get size(): number {
    // Count only live (non-expired) entries
    const now = this.nowFn();
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiry === null || now < entry.expiry) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all keys of live entries, from most to least recently used.
   */
  keys(): K[] {
    const now = this.nowFn();
    const result: K[] = [];

    for (const key of this.usageOrder) {
      const entry = this.entries.get(key);
      if (entry !== undefined) {
        if (entry.expiry === null || now < entry.expiry) {
          result.push(key);
        }
      }
    }

    return result;
  }
}
