export type PlainObject = Record<string, unknown>;

/**
 * A plain object is a non-null object whose prototype is Object.prototype or null.
 * Arrays, Dates, Maps, class instances and functions are not plain objects.
 */
function isPlainObject(val: unknown): val is PlainObject {
  if (typeof val !== 'object' || val === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Deeply clones plain objects and arrays to ensure the result shares no 
 * mutable references with the original arguments.
 * Non-plain objects (Date, Map, etc.) are kept by reference.
 * Prohibited keys (__proto__, constructor, prototype) are skipped.
 */
function deepClone(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => deepClone(item));
  }

  if (isPlainObject(val)) {
    const clone: PlainObject = {};
    for (const key in val) {
      if (Object.prototype.hasOwnProperty.call(val, key)) {
        // Security: Skip prototype-polluting keys
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        clone[key] = deepClone(val[key]);
      }
    }
    return clone;
  }

  return val;
}

/**
 * Deeply merges multiple config objects from left to right.
 * Later values overwrite earlier ones unless both are plain objects, 
 * in which case they are merged recursively.
 */
export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    // Ensure the source is actually a plain object before iterating
    if (!isPlainObject(obj)) {
      continue;
    }

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        // Security: Skip prototype-polluting keys at every level
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }

        const value = obj[key];

        // Incoming undefined values are skipped
        if (value === undefined) {
          continue;
        }

        const existingValue = result[key];

        if (isPlainObject(existingValue) && isPlainObject(value)) {
          // Both are plain objects: recurse merge
          result[key] = deepMerge(existingValue, value);
        } else {
          // Otherwise: replace existing value with a deep clone of the incoming value
          result[key] = deepClone(value);
        }
      }
    }
  }

  return result;
}
