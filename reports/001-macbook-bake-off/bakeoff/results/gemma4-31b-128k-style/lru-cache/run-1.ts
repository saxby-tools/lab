export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Internal entry structure to track value and expiry.
 */
interface CacheEntry<V> {
  value: V;
  expiry: number | null;
}

/**
 * Validates that the maximum number of entries is a positive integer.
 */
function validateMaxEntries(maxEntries: number): void {
  if (
    !Number.isInteger(maxEntries) ||
    maxEntries < 1
  ) {
    throw new RangeError("maxEntries must be an integer of 1 or more.");
  }
}

/**
 * Validates that the TTL is a finite number greater than 0.
 */
function validateTtl(ttlMs?: number): void {
  if (ttlMs === undefined) {
    return;
  }

  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0
  ) {
    throw new RangeError("ttlMs must be a finite number greater than 0.");
  }
}

/**
 * Calculates the expiry timestamp based on current time and TTL.
 */
function calculateExpiry(now: number, ttlMs?: number): number | null {
  if (ttlMs === undefined) {
    return null;
  }

  return now + ttlMs;
}

/**
 * Determines if an entry has exceeded its lifetime.
 */
function isExpired(entry: CacheEntry<unknown>, now: number): boolean {
  if (entry.expiry === null) {
    return false;
  }

  return now >= entry.expiry;
}

export class LruCache<K, V> {
  private readonly options: CacheOptions;
  private readonly cache = new Map<K, CacheEntry<V>>();

  constructor(options: CacheOptions) {
    validateMaxEntries(options.maxEntries);
    validateTtl(options.ttlMs);

    this.options = {
      now: Date.now,
      ...options,
    };
  }

  /**
   * Removes all entries that have exceeded their TTL.
   */
  private purgeExpired(): void {
    const now = this.options.now!();

    for (const [key, entry] of this.cache.entries()) {
      if (isExpired(entry, now)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Evicts the least recently used entry (the first key in the Map).
   */
  private evictLru(): void {
    const iterator = this.cache.keys();
    const oldestKey = iterator.next().value;

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Returns the value of a live entry and refreshes its recency.
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (isExpired(entry, this.options.now!())) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh recency by moving key to the end of the Map.
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Adds or replaces an entry, maintaining size limits and TTL.
   */
  set(key: K, value: V, ttlMs?: number): this {
    validateTtl(ttlMs);

    const now = this.options.now!();
    const expiry = calculateExpiry(now, ttlMs ?? this.options.ttlMs);
    const entry: CacheEntry<V> = { value, expiry };

    const isNew = !this.cache.has(key);

    if (isNew) {
      if (this.cache.size >= this.options.maxEntries) {
        this.purgeExpired();

        if (this.cache.size >= this.options.maxEntries) {
          this.evictLru();
        }
      }
    }

    // Delete and set ensures the entry is marked as most recently used.
    this.cache.delete(key);
    this.cache.set(key, entry);

    return this;
  }

  /**
   * Checks if a live entry exists without modifying recency.
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (isExpired(entry, this.options.now!())) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Removes a live entry from the cache.
   */
  delete(key: K): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (isExpired(entry, this.options.now!())) {
      this.cache.delete(key);
      return false;
    }

    return this.cache.delete(key);
  }

  /**
   * Wipes all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Returns the count of entries that have not yet expired.
   */
  get size(): number {
    this.purgeExpired();
    return this.cache.size;
  }

  /**
   * Returns live keys ordered from most to least recently used.
   */
  keys(): K[] {
    this.purgeExpired();

    // Map keys are LRU -> MRU, so we reverse for MRU -> LRU.
    return Array.from(this.cache.keys()).reverse();
  }
}
