export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

class Entry<V> {
  value: V;
  createdAt: number;
  ttl: number | undefined;

  constructor(value: V, createdAt: number, ttl: number | undefined) {
    this.value = value;
    this.createdAt = createdAt;
    this.ttl = ttl;
  }
}

export class LruCache<K, V> {
  private cache: Map<K, Entry<V>>;
  private maxEntries: number;
  private defaultTtl: number | undefined;
  private now: () => number;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;

    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }

    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.defaultTtl = ttlMs;
    this.now = now ?? (() => Date.now());
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end to mark as most recently used
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    // If key exists, just update it and move to end
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.value = value;
      entry.createdAt = this.now();
      entry.ttl = ttlMs;
      this.cache.delete(key);
      this.cache.set(key, entry);
    } else {
      // Check if we need to evict
      if (this.cache.size >= this.maxEntries) {
        this.removeExpired();
        if (this.cache.size >= this.maxEntries) {
          // Evict LRU (first item)
          const lruKey = this.cache.keys().next().value;
          if (lruKey !== undefined) {
            this.cache.delete(lruKey);
          }
        }
      }

      const ttl = ttlMs ?? this.defaultTtl;
      const entry = new Entry(value, this.now(), ttl);
      this.cache.set(key, entry);
    }

    return this;
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (entry === undefined) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (entry === undefined) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    this.cache.delete(key);
    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    // Remove expired entries before returning size
    this.removeExpired();
    return this.cache.size;
  }

  keys(): K[] {
    // Remove expired entries first
    this.removeExpired();

    // Return keys from most to least recently used
    // Map preserves insertion order, and we move used items to the end
    return Array.from(this.cache.keys()).reverse();
  }

  private isExpired(entry: Entry<V>): boolean {
    if (entry.ttl === undefined) return false;
    return this.now() >= entry.createdAt + entry.ttl;
  }

  private removeExpired(): void {
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
      }
    }
  }
}
