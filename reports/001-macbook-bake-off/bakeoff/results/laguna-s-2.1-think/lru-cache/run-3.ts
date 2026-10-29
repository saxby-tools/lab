export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiry: number | null; // timestamp when expired, null means never
  prev: Entry<V> | null;
  next: Entry<V> | null;
}

export class LruCache<K, V> {
  private options: CacheOptions;
  private map: Map<K, Entry<V>>;
  private head: Entry<V> | null = null; // most recently used
  private tail: Entry<V> | null = null; // least recently used

  constructor(options: CacheOptions) {
    if (
      !Number.isInteger(options.maxEntries) ||
      options.maxEntries < 1
    ) {
      throw new RangeError("maxEntries must be an integer of 1 or more");
    }
    this.options = options;
    this.map = new Map<K, Entry<V>>();
  }

  private get now(): number {
    const fn = this.options.now ?? Date.now;
    return fn();
  }

  private removeEntry(entry: Entry<V>): void {
    if (entry.prev) entry.prev.next = entry.next;
    else this.head = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    else this.tail = entry.prev;
    entry.prev = null;
    entry.next = null;
  }

  private addFirst(entry: Entry<V>): void {
    entry.next = this.head;
    entry.prev = null;
    if (this.head) this.head.prev = entry;
    else this.tail = entry;
    this.head = entry;
  }

  private validateTtl(ttlMs?: number): void {
    if (ttlMs !== undefined) {
      if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("ttlMs must be a finite number greater than 0");
      }
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    const n = this.now();
    if (entry.expiry !== null && n >= entry.expiry) {
      this.map.delete(key);
      this.removeExpiredEntry(entry);
      return undefined;
    }
    // mark as most recently used
    this.removeEntry(entry);
    this.addFirst(entry);
    return entry.value;
  }

  private removeExpiredEntry(entry: Entry<V>): void {
    this.removeEntry(entry);
  }

  private removeExpired(): void {
    const n = this.now();
    const keysToDelete: K[] = [];
    for (const [k, e] of this.map) {
      if (e.expiry !== null && n >= e.expiry) {
        keysToDelete.push(k);
      }
    }
    for (const k of keysToDelete) {
      const e = this.map.get(k);
      if (e) {
        this.map.delete(k);
        this.removeEntry(e);
      }
    }
  }

  set(key: K, value: V, ttlMs?: number): this {
    this.validateTtl(ttlMs);
    const effectiveTtl = ttlMs ?? this.options.ttlMs;
    const entry = this.map.get(key);
    const n = this.now();
    const expiry =
      effectiveTtl !== undefined && effectiveTtl > 0 ? n + effectiveTtl : null;

    if (entry) {
      // replace existing
      entry.value = value;
      entry.expiry = expiry;
      this.removeEntry(entry);
      this.addFirst(entry);
    } else {
      // new entry
      this.removeExpired();
      if (this.map.size >= this.options.maxEntries) {
        // evict LRU live entry
        if (this.tail) {
          this.map.delete(this.getKeyOf(this.tail));
          this.removeEntry(this.tail);
        }
      }
      const newEntry: Entry<V> = {
        value,
        expiry,
        prev: null,
        next: null,
      };
      this.map.set(key, newEntry);
      this.addFirst(newEntry);
    }
    return this;
  }

  private getKeyOf(entry: Entry<V>): K {
    for (const [k, v] of this.map) {
      if (v === entry) return k;
    }
    throw new Error("Entry not found in map");
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    const n = this.now();
    if (entry.expiry !== null && n >= entry.expiry) {
      this.map.delete(key);
      this.removeExpiredEntry(entry);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    const n = this.now();
    if (entry.expiry !== null && n >= entry.expiry) {
      return false;
    }
    this.map.delete(key);
    this.removeEntry(entry);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    // Count live entries only
    this.removeExpired();
    return this.map.size;
  }

  keys(): K[] {
    this.removeExpired();
    const result: K[] = [];
    let current = this.head;
    while (current) {
      result.push(this.getKeyOf(current));
      current = current.next;
    }
    return result;
  }
}
