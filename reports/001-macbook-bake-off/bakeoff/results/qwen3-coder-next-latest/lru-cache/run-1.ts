export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

class Entry<V> {
  value: V;
  expiryTime: number | null;
  recency: number;
  
  constructor(value: V, expiryTime: number | null, recency: number) {
    this.value = value;
    this.expiryTime = expiryTime;
    this.recency = recency;
  }
}

export class LruCache<K, V> {
  private entries: Map<K, Entry<V>>;
  private maxEntries: number;
  private defaultTtlMs: number | null;
  private now: () => number;
  private recencyCounter: number = 0;

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }
    
    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new RangeError("ttlMs must be a finite number greater than 0");
      }
    }
    
    this.entries = new Map();
    this.maxEntries = options.maxEntries;
    this.defaultTtlMs = options.ttlMs ?? null;
    this.now = options.now ?? (() => Date.now());
    this.recencyCounter = 0;
  }

  private isExpired(entry: Entry<V>, currentTime: number): boolean {
    if (entry.expiryTime === null) return false;
    return currentTime >= entry.expiryTime;
  }

  private getLiveEntries(): Entry<V>[] {
    const currentTime = this.now();
    return Array.from(this.entries.values())
      .filter(entry => !this.isExpired(entry, currentTime));
  }

  private evictIfNecessary(): void {
    // First remove all expired entries
    const currentTime = this.now();
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, currentTime)) {
        this.entries.delete(key);
      }
    }
    
    // If still at max capacity, evict the least recently used
    while (this.entries.size >= this.maxEntries) {
      if (this.entries.size === 0) break; // Safety check
      
      // Find the least recently used entry (minimum recency value)
      let minRecency = Infinity;
      let minKey: K | undefined = undefined;
      
      for (const [key, entry] of this.entries) {
        if (entry.recency < minRecency) {
          minRecency = entry.recency;
          minKey = key;
        }
      }
      
      if (minKey !== undefined) {
        this.entries.delete(minKey);
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    
    const currentTime = this.now();
    if (this.isExpired(entry, currentTime)) {
      this.entries.delete(key);
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
        throw new RangeError("ttlMs must be a finite number greater than 0");
      }
    }
    
    const currentTime = this.now();
    
    // If key already exists, just update the value and recency
    if (this.entries.has(key)) {
      const existingEntry = this.entries.get(key)!;
      
      // Set expiry time
      const ttl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
      const expiryTime = ttl === null ? null : currentTime + ttl;
      
      // Update value and recency
      existingEntry.value = value;
      existingEntry.expiryTime = expiryTime;
      this.recencyCounter++;
      existingEntry.recency = this.recencyCounter;
      
      return this;
    }
    
    // New key - need to handle eviction if at capacity
    // First remove expired entries (even for new keys)
    for (const [k, entry] of this.entries) {
      if (this.isExpired(entry, currentTime)) {
        this.entries.delete(k);
      }
    }
    
    // Check if we need to evict to make room
    if (this.entries.size >= this.maxEntries) {
      // Evict the least recently used
      let minRecency = Infinity;
      let minKey: K | undefined = undefined;
      
      for (const [k, entry] of this.entries) {
        if (entry.recency < minRecency) {
          minRecency = entry.recency;
          minKey = k;
        }
      }
      
      if (minKey !== undefined) {
        this.entries.delete(minKey);
      }
    }
    
    // Create new entry
    const ttl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
    const expiryTime = ttl === null ? null : currentTime + ttl;
    
    this.recencyCounter++;
    this.entries.set(key, new Entry(value, expiryTime, this.recencyCounter));
    
    return this;
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    
    const currentTime = this.now();
    if (this.isExpired(entry, currentTime)) {
      this.entries.delete(key);
      return false;
    }
    
    return true;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    
    if (!entry) return false;
    
    const currentTime = this.now();
    if (this.isExpired(entry, currentTime)) {
      this.entries.delete(key);
      return false;
    }
    
    this.entries.delete(key);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    const currentTime = this.now();
    let count = 0;
    
    for (const entry of this.entries.values()) {
      if (!this.isExpired(entry, currentTime)) {
        count++;
      }
    }
    
    return count;
  }

  keys(): K[] {
    const currentTime = this.now();
    const liveEntries: [K, Entry<V>][] = [];
    
    // Collect all live entries
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry, currentTime)) {
        liveEntries.push([key, entry]);
      }
    }
    
    // Sort by recency (most recent first)
    liveEntries.sort((a, b) => b[1].recency - a[1].recency);
    
    // Return just the keys
    return liveEntries.map(([key]) => key);
  }
}
