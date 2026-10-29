export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number | null;
}

export class LruCache<K, V> {
  private readonly maxEntries: number;
  private readonly defaultTtl: number | null;
  private readonly nowFn: () => number;
  private readonly map: Map<K, Entry<V>>;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;

    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    this.maxEntries = maxEntries;
    this.defaultTtl = ttlMs !== undefined ? ttlMs : null;
    this.nowFn = now ?? Date.now;
    this.map = new Map();
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    // Promote to most-recently-used
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    const existing = this.map.get(key);

    if (existing !== undefined && !this.isExpired(existing)) {
      // Replace an existing live entry – no eviction possible
      const expiresAt = this.computeExpiry(ttlMs);
      this.map.delete(key);
      this.map.set(key, { value, expiresAt });
      return this;
    }

    // Treat as a brand-new key (either truly new, or the stored entry was expired)
    if (existing !== undefined) {
      this.map.delete(key);
    }

    if (this.map.size >= this.maxEntries) {
      this.purgeExpired();
      if (this.map.size >= this.maxEntries) {
        // Evict the least-recently-used live entry (first in Map iteration order)
        const lruKey = this.map.keys().next().value as K;
        this.map.delete(lruKey);
      }
    }

    const expiresAt = this.computeExpiry(ttlMs);
    this.map.set(key, { value, expiresAt });
    return this;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry)) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
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
    this.purgeExpired();
    return this.map.size;
  }

  keys(): K[] {
    this.purgeExpired();
    // Map iterates least-recent → most-recent; spec wants most → least.
    return [...this.map.keys()].reverse();
  }

  // ── private helpers ──────────────────────────────────────────────

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt !== null && this.nowFn() >= entry.expiresAt;
  }

  private computeExpiry(ttlMs: number | undefined): number | null {
    const effectiveTtl = ttlMs !== undefined ? ttlMs : this.defaultTtl;
    return effectiveTtl !== null ? this.nowFn() + effectiveTtl : null;
  }

  private purgeExpired(): void {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.map.delete(key);
      }
    }
  }
}
