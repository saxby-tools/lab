export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

class Entry<V> {
  constructor(public value: V, public expiresAt: number | null, public createdAt: number) {}
}

export class LruCache<K, V> {
  private map: Map<K, Entry<V>> = new Map();
  private maxEntries: number;
  private defaultTtlMs: number | null;
  private now: () => number;

  constructor(options: CacheOptions) {
    const { maxEntries, ttlMs, now } = options;

    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }

    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    this.maxEntries = maxEntries;
    this.defaultTtlMs = ttlMs ?? null;
    this.now = now ?? (() => Date.now());
  }

  private isExpired(entry: Entry<V>): boolean {
    if (entry.expiresAt === null) return false;
    return this.now() >= entry.expiresAt;
  }

  private removeExpired(): void {
    for (const [key, entry] of this.map) {
      if (this.isExpired(entry)) {
        this.map.delete(key);
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry || this.isExpired(entry)) {
      if (entry) this.map.delete(key);
      return undefined;
    }
    // Move to most recently used
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a finite number greater than 0");
    }

    // If key already exists, delete first to re-insert as new entry
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    // Check size and evict if needed for NEW entries
    if (!this.map.has(key)) {
      this.removeExpired();
      if (this.map.size >= this.maxEntries) {
        // Evict LRU: the first key in the map is the least recently used
        const lruKey = this.map.keys().next().value;
        if (lruKey !== undefined) {
          this.map.delete(lruKey);
        }
      }
    }

    const createdAt = this.now();
    const expiresAt =
      ttlMs !== undefined ? createdAt + ttlMs :
      this.defaultTtlMs !== null ? createdAt + this.defaultTtlMs :
      null;

    this.map.set(key, new Entry(value, expiresAt, createdAt));
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
    if (!entry || this.isExpired(entry)) {
      if (entry) this.map.delete(key);
      return false;
    }
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    // Recompute live entries (in case some expired without being checked)
    this.removeExpired();
    return this.map.size;
  }

  keys(): K[] {
    this.removeExpired();
    return Array.from(this.map.keys());
  }
}
