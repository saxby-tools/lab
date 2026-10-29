export type PlainObject = Record<string, unknown>;

/**
 * Determines if a value is a plain object.
 * A plain object is a non-null object whose prototype is Object.prototype or null.
 */
function isPlainObject(val: unknown): val is PlainObject {
  if (typeof val !== 'object' || val === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Deeply clones a value.
 * Plain objects and arrays are copied recursively.
 * Non-plain objects (Dates, Maps, class instances, functions) are kept by reference.
 * Forbidden keys (__proto__, constructor, prototype) are skipped.
 */
function deepClone(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => deepClone(item));
  }

  if (isPlainObject(val)) {
    const cloned: PlainObject = {};
    for (const key in val) {
      if (Object.prototype.hasOwnProperty.call(val, key)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        cloned[key] = deepClone(val[key]);
      }
    }
    return cloned;
  }

  return val;
}

/**
 * Merges two objects recursively.
 * Later values win. Undefined values are skipped.
 */
function mergeTwo(target: PlainObject, source: PlainObject): PlainObject {
  const result: PlainObject = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      // Security: Skip forbidden keys to prevent prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      const sourceValue = source[key];
      const targetValue = result[key];

      // An incoming value of undefined is skipped
      if (sourceValue === undefined) {
        continue;
      }

      if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
        // Recursively merge if both are plain objects
        result[key] = mergeTwo(targetValue, sourceValue);
      } else {
        // Otherwise, replace the value with a deep clone of the incoming value
        result[key] = deepClone(sourceValue);
      }
    }
  }

  return result;
}

/**
 * Deeply merges multiple configuration objects from left to right.
 * Returns a new object and does not mutate any input arguments.
 */
export function deepMerge(...objects: PlainObject[]): PlainObject {
  return objects.reduce((acc, curr) => {
    return mergeTwo(acc, curr);
  }, {});
}
