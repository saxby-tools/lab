export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number | undefined; // undefined means never expires
}

export class LruCache<K, V> {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | undefined;
  private readonly nowFn: () => number;
  private readonly entries: Map<K, Entry<V>> = new Map();

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0 when given");
    }
    this.maxEntries = maxEntries;
    this.defaultTtlMs = ttlMs;
    this.nowFn = now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.delete(key);
      return undefined;
    }
    // Move to end to mark as most recently used
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0 when given");
    }

    const now = this.nowFn();
    const lifetime = ttlMs ?? this.defaultTtlMs;
    const expiresAt = lifetime !== undefined ? now + lifetime : undefined;
    const entry: Entry<V> = { value, expiresAt };

    const isNewKey = !this.entries.has(key);
    if (isNewKey) {
      // Before inserting, run eviction logic if currently at capacity
      this.evictIfNeeded(now);
    }

    // Delete and re-insert to update value, expiry, and recency,
    // or simply insert as MRU.
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries && isNewKey) {
      // If after potential expired cleanup cache is still full, evict LRU
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) {
        this.entries.delete(lruKey);
      }
    }
    this.entries.set(key, entry);

    return this;
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry)) {
      // Remove even if expired, for consistency; but only return true if it was live
      if (entry !== undefined) {
        this.entries.delete(key);
      }
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.removeExpiredEntries();
    return this.entries.size;
  }

  keys(): K[] {
    this.removeExpiredEntries();
    return Array.from(this.entries.keys()).reverse(); // most to least recently used
  }

  // --- Helpers ---

  private isExpired(entry: Entry<V>): boolean {
    if (entry.expiresAt === undefined) {
      return false;
    }
    return this.nowFn() >= entry.expiresAt;
  }

  private removeExpiredEntries(): void {
    const now = this.nowFn();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  private evictIfNeeded(now: number): void {
    // Only relevant if we're at capacity and inserting a new key
    if (this.entries.size < this.maxEntries) {
      return;
    }
    // First remove all expired entries
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
    // If still full, evict LRU (first key in insertion order)
    if (this.entries.size >= this.maxEntries) {
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) {
        this.entries.delete(lruKey);
      }
    }
  }
}
