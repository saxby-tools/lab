export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number | null;
}

function isValidTtl(ttl?: number): boolean {
  if (ttl === undefined) {
    return true;
  }

  if (!Number.isFinite(ttl)) {
    return false;
  }

  if (ttl <= 0) {
    return false;
  }

  return true;
}

function isExpired(entry: CacheEntry<V>, now: number): boolean {
  if (entry.expiresAt === null) {
    return false;
  }

  return now >= entry.expiresAt;
}

export class LruCache<K, V> {
  private readonly options: CacheOptions;
  private readonly now: () => number;
  private readonly cache = new Map<K, CacheEntry<V>>();

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries)) {
      throw new RangeError('maxEntries must be an integer');
    }

    if (options.maxEntries < 1) {
      throw new RangeError('maxEntries must be 1 or more');
    }

    if (!isValidTtl(options.ttlMs)) {
      throw new RangeError('ttlMs must be a finite number greater than 0');
    }

    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  private purgeExpired(): void {
    const currentTime = this.now();

    for (const [key, entry] of this.cache.entries()) {
      if (isExpired(entry, currentTime)) {
        this.cache.delete(key);
      }
    }
  }

  public get(key: K): V | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (isExpired(entry, this.now())) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh recency by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  public has(key: K): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (isExpired(entry, this.now())) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  public delete(key: K): boolean {
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (isExpired(entry, this.now())) {
      this.cache.delete(key);
      return false;
    }

    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public set(key: K, value: V, ttlMs?: number): this {
    if (!isValidTtl(ttlMs)) {
      throw new RangeError('ttlMs must be a finite number greater than 0');
    }

    const exists = this.cache.has(key);
    const currentTime = this.now();
    const lifetime = ttlMs ?? this.options.ttlMs;
    const expiresAt = lifetime !== undefined ? currentTime + lifetime : null;

    if (!exists) {
      this.handleEviction();
    }

    // Use delete + set to ensure key is moved to the end (MRU)
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt });

    return this;
  }

  private handleEviction(): void {
    if (this.cache.size < this.options.maxEntries) {
      return;
    }

    this.purgeExpired();

    if (this.cache.size < this.options.maxEntries) {
      return;
    }

    // Evict the first entry (least recently used)
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  public get size(): number {
    const currentTime = this.now();
    let count = 0;

    for (const entry of this.cache.values()) {
      if (!isExpired(entry, currentTime)) {
        count++;
      }
    }

    return count;
  }

  public keys(): K[] {
    const currentTime = this.now();
    const liveKeys: K[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (!isExpired(entry, currentTime)) {
        liveKeys.push(key);
      }
    }

    // Map maintains insertion order; reverse for MRU first
    return liveKeys.reverse();
  }
}
