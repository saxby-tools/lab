export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

class CacheEntry<V> {
  value: V;
  expiryTime: number;
  recency: number;

  constructor(value: V, expiryTime: number, recency: number) {
    this.value = value;
    this.expiryTime = expiryTime;
    this.recency = recency;
  }

  isExpired(now: number): boolean {
    // If expiryTime is Infinity, the entry never expires
    return this.expiryTime !== Infinity && now >= this.expiryTime;
  }
}

export class LruCache<K, V> {
  private maxEntries: number;
  private defaultTtlMs?: number;
  private now: () => number;
  private map: Map<K, CacheEntry<V>>;
  private recencyCounter: number;

  constructor(options: CacheOptions) {
    // Validate maxEntries
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError('maxEntries must be an integer >= 1');
    }

    // Validate ttlMs if provided
    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new RangeError('ttlMs must be a finite number > 0');
      }
    }

    // Validate now if provided
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new RangeError('now must be a function');
    }

    this.maxEntries = options.maxEntries;
    this.defaultTtlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
    this.map = new Map();
    this.recencyCounter = 0;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (entry.isExpired(this.now())) {
      this.map.delete(key);
      return undefined;
    }

    // Update recency
    this.recencyCounter++;
    entry.recency = this.recencyCounter;
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    // Validate ttlMs if provided
    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError('ttlMs must be a finite number > 0');
      }
    }

    // Get current time
    const now = this.now();

    // If key already exists, update it
    if (this.map.has(key)) {
      const entry = this.map.get(key)!;
      
      // Calculate expiry time
      const effectiveTtl = ttlMs !== undefined ? ttlMs : (this.defaultTtlMs ?? Infinity);
      const expiryTime = effectiveTtl === Infinity ? Infinity : now + effectiveTtl;

      // Update entry
      this.recencyCounter++;
      entry.value = value;
      entry.expiryTime = expiryTime;
      entry.recency = this.recencyCounter;
      return this;
    }

    // New key - need to potentially evict entries first

    // First, clean up expired entries (not necessarily all of them, but we'll do it to help eviction logic)
    // We need to do this before checking size, but we don't need to clean all expired entries
    // For simplicity, we'll check and remove expired entries as part of the eviction logic
    if (this.map.size >= this.maxEntries) {
      // Try to evict expired entries first
      const keys = Array.from(this.map.keys());
      for (const k of keys) {
        const entry = this.map.get(k)!;
        if (entry.isExpired(now)) {
          this.map.delete(k);
          if (this.map.size < this.maxEntries) break;
        }
      }

      // If still at capacity, evict LRU entry
      if (this.map.size >= this.maxEntries) {
        // Find LRU entry (lowest recency)
        let lruKey: K | null = null;
        let minRecency = Infinity;
        for (const [k, entry] of this.map.entries()) {
          if (entry.recency < minRecency) {
            minRecency = entry.recency;
            lruKey = k;
          }
        }

        // Evict the LRU entry
        if (lruKey !== null) {
          this.map.delete(lruKey);
        }
      }
    }

    // Add new entry
    const effectiveTtl = ttlMs !== undefined ? ttlMs : (this.defaultTtlMs ?? Infinity);
    const expiryTime = effectiveTtl === Infinity ? Infinity : now + effectiveTtl;
    this.recencyCounter++;
    this.map.set(key, new CacheEntry(value, expiryTime, this.recencyCounter));

    return this;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;

    // Check if expired
    return !entry.isExpired(this.now());
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    
    // If no entry or expired, delete and return false
    if (!entry) {
      return false;
    }

    // Check if expired
    if (entry.isExpired(this.now())) {
      this.map.delete(key);
      return false;
    }

    // Remove entry and return true
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    const now = this.now();
    let count = 0;
    
    for (const [key, entry] of this.map.entries()) {
      if (!entry.isExpired(now)) {
        count++;
      }
    }
    
    return count;
  }

  keys(): K[] {
    const now = this.now();
    const result: K[] = [];
    
    // Collect live entries
    const liveEntries: { key: K; recency: number }[] = [];
    
    for (const [key, entry] of this.map.entries()) {
      if (!entry.isExpired(now)) {
        liveEntries.push({ key, recency: entry.recency });
      }
    }
    
    // Sort by recency descending (most recent first)
    liveEntries.sort((a, b) => b.recency - a.recency);
    
    return liveEntries.map(e => e.key);
  }
}
