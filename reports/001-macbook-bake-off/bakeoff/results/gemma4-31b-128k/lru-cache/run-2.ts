export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiry: number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly options: CacheOptions;

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }

    if (options.ttlMs !== undefined) {
      this.validateTtl(options.ttlMs);
    }

    this.options = {
      ...options,
      now: options.now ?? Date.now,
    };
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }

    // Move to most recently used: delete and re-insert
    this.map.delete(key);
    this.map.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    const effectiveTtl = ttlMs ?? this.options.ttlMs;

    if (effectiveTtl !== undefined) {
      this.validateTtl(effectiveTtl);
    }

    const isUpdate = this.map.has(key);

    // Eviction logic: only when adding a NEW key and cache is full
    if (!isUpdate && this.map.size >= this.options.maxEntries) {
      // 1. Remove every expired entry
      for (const [k, v] of this.map.entries()) {
        if (this.isExpired(v)) {
          this.map.delete(k);
        }
      }

      // 2. If still full, evict the least recently used (the first item in Map)
      if (this.map.size >= this.options.maxEntries) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey !== undefined) {
          this.map.delete(oldestKey);
        }
      }
    }

    const expiry =
      effectiveTtl === undefined
        ? Infinity
        : this.options.now() + effectiveTtl;

    // Replacing existing key never evicts, but resets recency and TTL
    if (isUpdate) {
      this.map.delete(key);
    }

    this.map.set(key, { value, expiry });
    return this;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.map.delete(key);
      return false;
    }

    return true;
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
    let count = 0;
    for (const entry of this.map.values()) {
      if (!this.isExpired(entry)) {
        count++;
      }
    }
    return count;
  }

  keys(): K[] {
    const liveKeys: K[] = [];
    for (const [key, entry] of this.map.entries()) {
      if (!this.isExpired(entry)) {
        liveKeys.push(key);
      }
    }
    // Map iteration is oldest -> newest. 
    // Required order is most recent -> least recent.
    return liveKeys.reverse();
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    if (entry.expiry === Infinity) return false;
    return this.options.now() >= entry.expiry;
  }

  private validateTtl(ttl: number): void {
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }
  }
}
