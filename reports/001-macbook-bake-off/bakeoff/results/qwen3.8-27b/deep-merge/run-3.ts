export type PlainObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(val: unknown): val is PlainObject {
  if (val === null || typeof val !== "object") return false;
  if (Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

const SKIPPED = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// Deep clone – produces a fresh copy of any plain object / array while
// keeping non-plain objects (Date, Map, class instances, functions, …) by
// reference.
// ---------------------------------------------------------------------------

function deepClone(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => deepClone(item));
  }
  if (isPlainObject(val)) {
    const out: PlainObject = {};
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (SKIPPED.has(key)) continue;
      out[key] = deepClone(val[key]);
    }
    return out;
  }
  // Primitives, null, Date, Map, class instances, functions – keep by ref.
  return val;
}

// ---------------------------------------------------------------------------
// Merge a single source into a mutable target (which is always *our* copy).
// ---------------------------------------------------------------------------

function mergeInto(target: PlainObject, source: PlainObject): void {
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (SKIPPED.has(key)) continue;

    const incoming: unknown = source[key];

    // `undefined` incoming → skip, existing value stays
    if (incoming === undefined) continue;

    if (isPlainObject(incoming)) {
      const existing: unknown = target[key];
      if (isPlainObject(existing)) {
        // Both plain objects → recursive merge into our own copy
        mergeInto(existing, incoming);
      } else {
        // Replace (or first-seen) with a deep clone
        target[key] = deepClone(incoming);
      }
    } else if (Array.isArray(incoming)) {
      // Arrays always replace, but are deep-copied
      target[key] = deepClone(incoming);
    } else {
      // Primitives, null, Date, Map, class instances, functions, …
      target[key] = incoming;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};
  for (let i = 0; i < objects.length; i++) {
    mergeInto(result, objects[i]);
  }
  return result;
}
