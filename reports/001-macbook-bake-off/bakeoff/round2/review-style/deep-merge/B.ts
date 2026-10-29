export type PlainObject = Record<string, unknown>;

// These keys would either mutate a prototype or create a prototype
// property; they must never be copied or written.
const SKIPPED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

// A plain object is non-null, typeof "object", not an Array, and its
// prototype is Object.prototype or null (covers Object.create(null)).
function isPlainObject(value: unknown): value is PlainObject {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Deep-copy plain objects and arrays so the result shares no nested
// structure with any argument.  Every other reference type (Date,
// Map, function, class instance) is returned as-is per spec.
function deepClone(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }

  if (isPlainObject(value)) {
    const copy: PlainObject = {};
    // Object.keys yields only own, enumerable, string keys,
    // which satisfies the "ignore symbol keys" requirement.
    for (const key of Object.keys(value)) {
      if (SKIPPED_KEYS.has(key)) continue;
      copy[key] = deepClone(value[key]);
    }
    return copy;
  }

  // Date, Map, class instance, function, etc.
  return value;
}

// Merge every key of `source` into `target` in place.  `target`
// must be a fresh object we own, so mutating it is safe.
function mergeInto(target: PlainObject, source: PlainObject): void {
  for (const key of Object.keys(source)) {
    if (SKIPPED_KEYS.has(key)) continue;

    const incoming: unknown = source[key];
    if (incoming === undefined) continue;

    const existing: unknown = target[key];
    if (isPlainObject(existing) && isPlainObject(incoming)) {
      mergeInto(existing, incoming);
      continue;
    }

    target[key] = deepClone(incoming);
  }
}

// Layer objects left-to-right; later keys win.  With no arguments
// the result is an empty object.
export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};
  for (const obj of objects) {
    mergeInto(result, obj);
  }
  return result;
}
