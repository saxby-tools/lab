export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number | undefined;
}

export class LruCache<K, V> {
  private readonly maxEntries: number;
  private readonly defaultTtl: number | undefined;
  private readonly now: () => number;
  private readonly map: Map<K, CacheEntry<V>>;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer >= 1");
    }
    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("ttlMs must be a finite number > 0");
      }
    }
    this.maxEntries = maxEntries;
    this.defaultTtl = ttlMs;
    this.now = now ?? Date.now;
    this.map = new Map();
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return entry.expiresAt !== undefined && this.now() >= entry.expiresAt;
  }

  private removeExpired(): void {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.map.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined || this.isExpired(entry)) {
      return undefined;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("ttlMs must be a finite number > 0");
      }
    }

    // If key exists, just update it and move to end
    if (this.map.has(key)) {
      const entry: CacheEntry<V> = {
        value,
        expiresAt:
          ttlMs !== undefined ? this.now() + ttlMs : this.defaultTtl !== undefined ? this.now() + this.defaultTtl : undefined,
      };
      this.map.delete(key);
      this.map.set(key, entry);
      return this;
    }

    // New key
    // First remove expired entries
    this.removeExpired();

    // Check capacity
    if (this.map.size >= this.maxEntries) {
      // Evict least recently used (first item)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }

    const entry: CacheEntry<V> = {
      value,
      expiresAt:
        ttlMs !== undefined ? this.now() + ttlMs : this.defaultTtl !== undefined ? this.now() + this.defaultTtl : undefined,
    };
    this.map.set(key, entry);
    return this;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined || this.isExpired(entry)) {
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined || this.isExpired(entry)) {
      return false;
    }
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    let count = 0;
    for (const entry of this.map.values()) {
      if (!this.isExpired(entry)) {
        count++;
      }
    }
    return count;
  }

  keys(): K[] {
    const result: K[] = [];
    for (const [key, entry] of this.map) {
      if (!this.isExpired(entry)) {
        result.push(key);
      }
    }
    return result;
  }
}
