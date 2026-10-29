export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiry: number | null;
}

export class LruCache<K, V> {
  private readonly options: CacheOptions;
  private readonly now: () => number;
  private readonly cache = new Map<K, CacheEntry<V>>();

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries)) {
      throw new RangeError("maxEntries must be an integer");
    }

    if (options.maxEntries < 1) {
      throw new RangeError("maxEntries must be 1 or more");
    }

    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs)) {
        throw new RangeError("ttlMs must be a finite number");
      }

      if (options.ttlMs <= 0) {
        throw new RangeError("ttlMs must be greater than 0");
      }
    }

    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    if (entry.expiry === null) {
      return false;
    }

    return this.now() >= entry.expiry;
  }

  private prune(): void {
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
      }
    }
  }

  get size(): number {
    let count = 0;

    for (const entry of this.cache.values()) {
      if (!this.isExpired(entry)) {
        count++;
      }
    }

    return count;
  }

  keys(): K[] {
    const liveKeys: K[] = [];

    for (const key of this.cache.keys()) {
      const entry = this.cache.get(key);

      if (entry && !this.isExpired(entry)) {
        liveKeys.push(key);
      }
    }

    return liveKeys.reverse();
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    const effectiveTtl = ttlMs ?? this.options.ttlMs;

    if (effectiveTtl !== undefined) {
      if (!Number.isFinite(effectiveTtl)) {
        throw new RangeError("ttlMs must be a finite number");
      }

      if (effectiveTtl <= 0) {
        throw new RangeError("ttlMs must be greater than 0");
      }
    }

    const expiry = effectiveTtl
      ? this.now() + effectiveTtl
      : null;

    const exists = this.cache.has(key);

    if (!exists && this.size >= this.options.maxEntries) {
      this.prune();

      if (this.size >= this.options.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
    }

    this.cache.delete(key);
    this.cache.set(key, { value, expiry });

    return this;
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  delete(key: K): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

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
}
