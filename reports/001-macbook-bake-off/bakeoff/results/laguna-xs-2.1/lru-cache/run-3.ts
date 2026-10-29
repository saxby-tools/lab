interface INode {
  key: K;
  prev: INode | null;
  next: INode | null;
}

interface IEntryData<K, V> {
  value: V;
  expiry: number;
  node: INode;
}

export interface CacheOptions<K = unknown> {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

export class LruCache<K, V> {
  private head: INode | null = null;
  private tail: INode | null = null;
  private readonly entryMap: Map<K, IEntryData<K, V>> = new Map();
  private readonly maxEntries: number;
  private readonly ttlMs: number | undefined;
  private readonly nowFn: () => number;

  constructor(options: CacheOptions<K>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("maxEntries must be an integer >= 1");
    }

    this.maxEntries = options.maxEntries;

    if (options.ttlMs !== undefined) {
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new RangeError("ttlMs must be a finite positive number");
      }
    }

    this.ttlMs = options.ttlMs;
    this.nowFn = options.now ?? (() => Date.now());
  }

  get(key: K): V | undefined {
    const entry = this.entryMap.get(key);
    if (!entry) return undefined;

    const nowTime = this.nowFn();
    if (nowTime >= entry.expiry) {
      return undefined;
    }

    this.moveToFront(entry.node);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    if (ttlMs !== undefined) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("set ttlMs must be a finite positive number");
      }
    }

    const currentTime = this.nowFn();
    const activeTTL = ttlMs ?? this.ttlMs;
    const expiry = activeTTL === undefined ? Infinity : currentTime + activeTTL;

    const existingEntry = this.entryMap.get(key);

    if (existingEntry) {
      // Update existing entry
      existingEntry.value = value;
      existingEntry.expiry = expiry;
      this.moveToFront(existingEntry.node);
      return this;
    }

    // New entry
    const node: INode = { key, prev: null, next: null };
    const entry: IEntryData<K, V> = {
      value,
      expiry,
      node,
    };
    this.entryMap.set(key, entry);

    // Check if there's room
    if (this.entryMap.size > this.maxEntries) {
      this.removeExpiredEntries();
      if (this.entryMap.size > this.maxEntries) {
        // Still full, evict LRU
        if (this.tail) {
          const lruKey = this.tail.key;
          this.unlink(this.tail);
          this.entryMap.delete(lruKey);
        }
      }
    }

    // Move to front if necessary
    if (this.entryMap.size <= this.maxEntries) {
      this.insertToFront(node);
    }

    return this;
  }

  has(key: K): boolean {
    const entry = this.entryMap.get(key);
    return entry !== undefined && this.nowFn() < entry.expiry;
  }

  delete(key: K): boolean {
    const entry = this.entryMap.get(key);
    if (!entry || this.nowFn() >= entry.expiry) {
      return false;
    }

    this.unlink(entry.node);
    this.entryMap.delete(key);
    return true;
  }

  clear(): void {
    this.entryMap.clear();
    this.head = null;
    this.tail = null;
  }

  get size(): number {
    let count = 0;
    for (const entry of this.entryMap.values()) {
      if (this.nowFn() < entry.expiry) count++;
    }
    return count;
  }

  keys(): K[] {
    const result: K[] = [];
    let current = this.head;
    while (current) {
      const entry = this.entryMap.get(current.key);
      if (entry && this.nowFn() < entry.expiry) {
        result.push(current.key);
      }
      current = current.next;
    }
    return result;
  }

  private moveToFront(node: INode): void {
    if (node === this.head) return;
    this.unlink(node);
    this.insertToFront(node);
  }

  private insertToFront(node: INode): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    } else {
      this.tail = node;
    }

    this.head = node;
  }

  private unlink(node: INode): void {
    const { prev, next } = node;

    if (prev) {
      prev.next = next;
    } else {
      this.head = next;
    }

    if (next) {
      next.prev = prev;
    } else {
      this.tail = prev;
    }
  }

  private removeExpiredEntries(): void {
    const now = this.nowFn();
    const keysToRemove: K[] = [];

    this.entryMap.forEach((entry, key) => {
      if (entry.expiry <= now) {
        keysToRemove.push(key);
      }
    });

    for (const key of keysToRemove) {
      const entry = this.entryMap.get(key);
      if (entry) {
        this.unlink(entry.node);
        this.entryMap.delete(key);
      }
    }
  }
}
