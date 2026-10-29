export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expireAt?: number;
}

export class LruCache<K, V> {
  #map: Map<K, Entry<V>> = new Map();
  #maxEntries: number;
  #ttlMs?: number;
  #nowFn: () => number;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#nowFn = now ?? (() => Date.now());
  }

  get(key: K): V | undefined {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (this.#isExpired(entry)) {
      this.#map.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }
    const existing = this.#map.get(key);
    if (existing) {
      // Replace: just update value and expiry, move to end
      this.#map.delete(key);
      this.#map.set(key, {
        value,
        expireAt: ttlMs !== undefined ? this.#nowFn() + ttlMs : this.#computeExpireAt(),
      });
      return this;
    }
    // New key: possibly evict
    this.#removeExpired();
    if (this.#map.size >= this.#maxEntries) {
      const firstKey = this.#map.keys().next().value as K;
      this.#map.delete(firstKey);
    }
    this.#map.set(key, {
      value,
      expireAt: ttlMs !== undefined ? this.#nowFn() + ttlMs : this.#computeExpireAt(),
    });
    return this;
  }

  has(key: K): boolean {
    const entry = this.#map.get(key);
    if (!entry) return false;
    if (this.#isExpired(entry)) {
      this.#map.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.#map.get(key);
    if (!entry) return false;
    if (this.#isExpired(entry)) {
      this.#map.delete(key);
      return false;
    }
    this.#map.delete(key);
    return true;
  }

  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    this.#removeExpired();
    return this.#map.size;
  }

  keys(): K[] {
    this.#removeExpired();
    return [...this.#map.keys()].reverse();
  }

  #isExpired(entry: Entry<V>): boolean {
    return entry.expireAt !== undefined && this.#nowFn() >= entry.expireAt;
  }

  #computeExpireAt(): number | undefined {
    return this.#ttlMs !== undefined ? this.#nowFn() + this.#ttlMs : undefined;
  }

  #removeExpired(): void {
    for (const [key, entry] of this.#map) {
      if (this.#isExpired(entry)) {
        this.#map.delete(key);
      }
    }
  }
}
