// ---- Types ------------------------------------------------------------

export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

// ---- Validation -------------------------------------------------------

function checkMax(maxEntries: number): void {
  if (!Number.isInteger(maxEntries)) {
    throw new RangeError("maxEntries must be an integer");
  }

  if (maxEntries < 1) {
    throw new RangeError("maxEntries must be 1 or more");
  }
}

function checkTtl(ttlMs: number | undefined): void {
  if (ttlMs === undefined) {
    return;
  }

  if (!Number.isFinite(ttlMs)) {
    throw new RangeError("ttlMs must be finite");
  }

  if (ttlMs <= 0) {
    throw new RangeError("ttlMs must be greater than 0");
  }
}

// ---- Cache ------------------------------------------------------------

export class LruCache<K, V> {
  #max: number;
  #ttl: number | undefined;
  #now: () => number;
  #entries = new Map<K, Entry<V>>();

  constructor(options: CacheOptions) {
    checkMax(options.maxEntries);
    checkTtl(options.ttlMs);

    this.#max = options.maxEntries;
    this.#ttl = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  #isLive(entry: Entry<V>): boolean {
    return this.#now() < entry.expiresAt;
  }

  #purge(): void {
    for (const [key, entry] of this.#entries) {
      if (!this.#isLive(entry)) {
        this.#entries.delete(key);
      }
    }
  }

  #live(key: K): Entry<V> | undefined {
    const entry = this.#entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (!this.#isLive(entry)) {
      this.#entries.delete(key);

      return undefined;
    }

    return entry;
  }

  get(key: K): V | undefined {
    const entry = this.#live(key);

    if (!entry) {
      return undefined;
    }

    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    checkTtl(ttlMs);

    const lifetime = ttlMs ?? this.#ttl;
    const expiresAt = lifetime === undefined
      ? Infinity
      : this.#now() + lifetime;

    const replacing = this.#live(key) !== undefined;

    

    if (!replacing && this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value as K;

      this.#entries.delete(oldest);
    }

    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt });

    return this;
  }

  has(key: K): boolean {
    return this.#live(key) !== undefined;
  }

  delete(key: K): boolean {
    const live = this.#live(key) !== undefined;

    this.#entries.delete(key);

    return live;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    this.#purge();

    return this.#entries.size;
  }

  keys(): K[] {
    this.#purge();

    return [...this.#entries.keys()].reverse();
  }
}
