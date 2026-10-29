export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiry: number | null;
}

export class LruCache<K, V> {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | undefined;
  private readonly nowFn: () => number;
  private readonly map: Map<K, Entry<V>>;

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer >= 1");
    }
    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new RangeError("ttlMs must be a finite number > 0");
      }
    }
    this.maxEntries = options.maxEntries;
    this.defaultTtlMs = options.ttlMs;
    this.nowFn = options.now ?? Date.now;
    this.map = new Map();
  }

  private isExpired(entry: Entry<V>, now: number): boolean {
    return entry.expiry !== null && now >= entry.expiry;
  }

  private purgeExpired(): void {
    const now = this.nowFn();
    for (const [key, entry] of this.map) {
      if (entry.expiry !== null && now >= entry.expiry) {
        this.map.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.isExpired(entry, this.nowFn())) {
      this.map.delete(key);
      return undefined;
    }
    // Promote to most-recently-used by moving to end of map
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    const effectiveTtl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
    if (effectiveTtl !== undefined) {
      if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
        throw new RangeError("ttlMs must be a finite number > 0");
      }
    }

    const now = this.nowFn();
    const entry: Entry<V> = {
      value,
      expiry: effectiveTtl !== undefined ? now + effectiveTtl : null,
    };

    // Replacing an existing key (even if expired) never evicts.
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, entry);
      return this;
    }

    // New key: make room if necessary.
    if (this.map.size >= this.maxEntries) {
      this.purgeExpired();
      if (this.map.size >= this.maxEntries) {
        // Evict the least-recently-used entry (front of the map).
        const lruKey = this.map.keys().next().value as K;
        this.map.delete(lruKey);
      }
    }

    this.map.set(key, entry);
    return this;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry, this.nowFn())) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry, this.nowFn())) {
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
    const now = this.nowFn();
    let count = 0;
    for (const entry of this.map.values()) {
      if (entry.expiry === null || now < entry.expiry) {
        count++;
      }
    }
    return count;
  }

  keys(): K[] {
    const now = this.nowFn();
    const live: K[] = [];
    for (const [key, entry] of this.map) {
      if (entry.expiry === null || now < entry.expiry) {
        live.push(key);
      }
    }
    // Map iterates oldest→newest; reverse to get most→least recently used.
    live.reverse();
    return live;
  }
}
