const SKIP_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export type PlainObject = Record<string, unknown>;


// A plain object has Object.prototype or null as its prototype.
// Arrays, Date, Map, class instances, and functions are excluded.
function isPlainObject(val: unknown): val is PlainObject {
  if (val === null || val === undefined) {
    return false;
  }

  if (typeof val !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}


// Deep-copies plain objects and arrays so the result shares
// no nested containers with the input.  Non-plain values
// (Date, Map, function, …) are returned by reference.
function deepClone(value: unknown): unknown {
  if (isPlainObject(value)) {
    const out: PlainObject = {};

    for (const key of Object.keys(value)) {
      if (SKIP_KEYS.has(key)) {
        continue;
      }
      out[key] = deepClone(value[key]);
    }

    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }

  // Date, Map, class instance, function, primitive — keep ref.
  return value;
}


// Merges plain objects left-to-right.  Later sources win.
// Recursive merge happens only when both sides are plain objects;
// arrays and every other type replace outright.
export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    // Guard against unexpected non-plain values at runtime.
    if (!isPlainObject(obj)) {
      continue;
    }

    for (const key of Object.keys(obj)) {
      // Never copy or let these keys alter any prototype.
      if (SKIP_KEYS.has(key)) {
        continue;
      }

      const incoming = obj[key];

      // undefined means "no opinion"; keep whatever we have.
      if (incoming === undefined) {
        continue;
      }

      const existing = result[key];

      if (isPlainObject(incoming) && isPlainObject(existing)) {
        // Recurse so nested config layers compose.
        result[key] = deepMerge(existing, incoming);
        continue;
      }

      // null, arrays, scalars, Date, Map, etc. — replace,
      // but deep-copy any plain object / array inside.
      result[key] = deepClone(incoming);
    }
  }

  return result;
}
