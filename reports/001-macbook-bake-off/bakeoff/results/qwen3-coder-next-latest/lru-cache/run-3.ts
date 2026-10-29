export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

class CacheEntry<V> {
  value: V;
  expiryTime: number;
  recencyOrder: number;

  constructor(value: V, expiryTime: number, recencyOrder: number) {
    this.value = value;
    this.expiryTime = expiryTime;
    this.recencyOrder = recencyOrder;
  }
}

export class LruCache<K, V> {
  private maxEntries: number;
  private defaultTtlMs?: number;
  private now: () => number;
  private map: Map<K, CacheEntry<V>>;
  private recencyCounter: number;

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer >= 1");
    }
    if (options.ttlMs !== undefined && !this.isValidTtl(options.ttlMs)) {
      throw new RangeError("ttlMs must be a finite number > 0");
    }
    this.maxEntries = options.maxEntries;
    this.defaultTtlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
    this.map = new Map();
    this.recencyCounter = 0;
  }

  private isValidTtl(ttl: number): boolean {
    return Number.isFinite(ttl) && ttl > 0;
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    // If expiryTime is Infinity (no TTL), it's not expired
    return this.now() >= entry.expiryTime;
  }

  private getLiveEntry(key: K): CacheEntry<V> | undefined {
    const entry = this.map.get(key);
    if (entry && this.isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: K): V | undefined {
    const entry = this.getLiveEntry(key);
    if (!entry) return undefined;

    // Update recency
    this.recencyCounter++;
    entry.recencyOrder = this.recencyCounter;
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    // Validate ttlMs if provided
    if (ttlMs !== undefined && !this.isValidTtl(ttlMs)) {
      throw new RangeError("ttlMs must be a finite number > 0");
    }

    // Check if key already exists
    const existingEntry = this.map.get(key);
    if (existingEntry) {
      // Update value and recency
      const ttl = ttlMs ?? this.defaultTtlMs ?? Infinity;
      const expiryTime = ttl === Infinity ? Infinity : this.now() + ttl;
      this.recencyCounter++;
      this.map.set(key, new CacheEntry(value, expiryTime, this.recencyCounter));
      return this;
    }

    // For new keys, ensure we have space
    // First, remove expired entries
    for (const k of [...this.map.keys()]) {
      const entry = this.map.get(k);
      if (entry && this.isExpired(entry)) {
        this.map.delete(k);
      }
    }

    // If still at max capacity, evict LRU
    if (this.map.size >= this.maxEntries) {
      // Find the least recently used (smallest recencyOrder)
      let lruKey: K | undefined;
      let minRecency = Number.MAX_VALUE;
      for (const [k, entry] of this.map.entries()) {
        if (entry.recencyOrder < minRecency) {
          minRecency = entry.recencyOrder;
          lruKey = k;
        }
      }
      if (lruKey !== undefined) {
        this.map.delete(lruKey);
      }
    }

    // Add new entry
    const ttl = ttlMs ?? this.defaultTtlMs ?? Infinity;
    const expiryTime = ttl === Infinity ? Infinity : this.now() + ttl;
    this.recencyCounter++;
    this.map.set(key, new CacheEntry(value, expiryTime, this.recencyCounter));

    return this;
  }

  has(key: K): boolean {
    const entry = this.getLiveEntry(key);
    return entry !== undefined;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    
    if (this.isExpired(entry)) {
      this.map.delete(key);
      return false;
    }
    
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    // Count live entries only
    let count = 0;
    for (const [key, entry] of this.map.entries()) {
      if (!this.isExpired(entry)) {
        count++;
      } else {
        // Clean up expired entries
        this.map.delete(key);
      }
    }
    return count;
  }

  keys(): K[] {
    const result: K[] = [];
    const entries: [K, CacheEntry<V>][] = [];

    // Collect live entries and remove expired ones
    for (const [key, entry] of this.map.entries()) {
      if (!this.isExpired(entry)) {
        entries.push([key, entry]);
      } else {
        this.map.delete(key);
      }
    }

    // Sort by recency (most recent first)
    entries.sort((a, b) => b[1].recencyOrder - a[1].recencyOrder);

    // Extract keys
    for (const [key] of entries) {
      result.push(key);
    }

    return result;
  }
}
