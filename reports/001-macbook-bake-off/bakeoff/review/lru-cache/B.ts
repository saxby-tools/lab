export interface CacheOptions {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}

class Node<K, V> {
  constructor(
    public key: K,
    public value: V,
    public expiresAt: number | undefined,
  ) {}
  prev: Node<K, V> | null = null;
  next: Node<K, V> | null = null;
}

function validateTtl(ttlMs: number | undefined, context: string): void {
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new RangeError(`${context}: ttlMs must be a finite number greater than 0`);
  }
}

export class LruCache<K, V> {
  private readonly _maxEntries: number;
  private readonly _defaultTtl: number | undefined;
  private readonly _now: () => number;
  private readonly _map: Map<K, Node<K, V>>;
  private _head: Node<K, V> | null = null;
  private _tail: Node<K, V> | null = null;

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError('maxEntries must be an integer >= 1');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new RangeError('now must be a function');
    }
    validateTtl(options.ttlMs, 'CacheOptions');

    this._maxEntries = options.maxEntries;
    this._defaultTtl = options.ttlMs;
    this._now = options.now ?? Date.now;
    this._map = new Map();
  }

  get size(): number {
    let count = 0;
    for (let node = this._head; node !== null; node = node.next) {
      if (!this._isExpired(node)) count++;
    }
    return count;
  }

  get(key: K): V | undefined {
    const node = this._map.get(key);
    if (node === undefined) return undefined;

    if (this._isExpired(node)) {
      this._remove(node);
      this._map.delete(key);
      return undefined;
    }

    this._unlink(node);
    this._pushFront(node);
    return node.value;
  }

  set(key: K, value: V, ttlMs?: number): this {
    validateTtl(ttlMs, 'set()');

    const ttl = ttlMs ?? this._defaultTtl;
    const expiresAt = ttl !== undefined ? this._now() + ttl : undefined;

    const existing = this._map.get(key);

    if (existing !== undefined && !this._isExpired(existing)) {
      // Replace live entry in place — never evicts
      this._unlink(existing);
      existing.value = value;
      existing.expiresAt = expiresAt;
      this._pushFront(existing);
      return this;
    }

    // Key is absent or stale — treat as a new insertion
    if (existing !== undefined) {
      this._remove(existing);
      this._map.delete(key);
    }

    // Purge every expired entry before deciding on eviction
    this._purgeExpired();

    // Evict LRU if still at capacity
    if (this._map.size >= this._maxEntries) {
      const lru = this._tail!;
      this._remove(lru);
      this._map.delete(lru.key);
    }

    const node = new Node<K, V>(key, value, expiresAt);
    this._pushFront(node);
    this._map.set(key, node);
    return this;
  }

  has(key: K): boolean {
    const node = this._map.get(key);
    if (node === undefined) return false;

    if (this._isExpired(node)) {
      this._remove(node);
      this._map.delete(key);
      return false;
    }
    // Does NOT change recency
    return true;
  }

  delete(key: K): boolean {
    const node = this._map.get(key);
    if (node === undefined) return false;

    if (this._isExpired(node)) {
      this._remove(node);
      this._map.delete(key);
      return false;
    }

    this._remove(node);
    this._map.delete(key);
    return true;
  }

  clear(): void {
    this._map.clear();
    this._head = null;
    this._tail = null;
  }

  keys(): K[] {
    const result: K[] = [];
    for (let node = this._head; node !== null; node = node.next) {
      if (!this._isExpired(node)) {
        result.push(node.key);
      }
    }
    // Does NOT change recency
    return result;
  }

  // --- internals ---

  private _isExpired(node: Node<K, V>): boolean {
    return node.expiresAt !== undefined && this._now() >= node.expiresAt;
  }

  private _pushFront(node: Node<K, V>): void {
    node.prev = null;
    node.next = this._head;
    if (this._head !== null) {
      this._head.prev = node;
    }
    this._head = node;
    if (this._tail === null) {
      this._tail = node;
    }
  }

  private _unlink(node: Node<K, V>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this._head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this._tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  private _remove(node: Node<K, V>): void {
    this._unlink(node);
  }

  private _purgeExpired(): void {
    let current: Node<K, V> | null = this._tail;
    while (current !== null) {
      const prev = current.prev;
      if (this._isExpired(current)) {
        this._unlink(current);
        this._map.delete(current.key);
      }
      current = prev;
    }
  }
}
