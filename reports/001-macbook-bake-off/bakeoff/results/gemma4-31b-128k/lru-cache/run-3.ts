export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiry: number; // timestamp in ms, Infinity if no expiry
}

export class LruCache<K, V> {
  private readonly options: CacheOptions;
  private readonly cache = new Map<K, CacheEntry<V>>();

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more.");
    }
    if (
      options.ttlMs !== undefined &&
      (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
    ) {
      throw new RangeError("ttlMs must be a finite number greater than 0.");
    }
    this.options = options;
  }

  private getNow(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    if (entry.expiry === Infinity) return false;
    return this.getNow() >= entry.expiry;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh recency: remove and re-insert
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    const ttl = ttlMs ?? this.options.ttlMs;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0.");
    }

    const isNewKey = !this.cache.has(key);
    const now = this.getNow();
    const expiry = ttl !== undefined ? now + ttl : Infinity;

    if (isNewKey && this.cache.size >= this.options.maxEntries) {
      // 1. Remove every expired entry first
      for (const [k, v] of this.cache.entries()) {
        if (this.isExpired(v)) {
          this.cache.delete(k);
        }
      }

      // 2. If still full, evict the least recently used live entry
      // Map keys are iterated in insertion order (oldest first)
      if (this.cache.size >= this.options.maxEntries) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
          this.cache.delete(firstKey);
        }
      }
    }

    // Update or add entry (always moves to most recently used)
    this.cache.delete(key);
    this.cache.set(key, { value, expiry });

    return this;
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

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
    let liveCount = 0;
    for (const [k, v] of this.cache.entries()) {
      if (this.isExpired(v)) {
        this.cache.delete(k);
      } else {
        liveCount++;
      }
    }
    return liveCount;
  }

  keys(): K[] {
    const liveKeys: K[] = [];
    for (const [k, v] of this.cache.entries()) {
      if (this.isExpired(v)) {
        this.cache.delete(k);
      } else {
        liveKeys.push(k);
      }
    }
    // Map iterates oldest to newest; reverse to get most to least recently used
    return liveKeys.reverse();
  }
}
