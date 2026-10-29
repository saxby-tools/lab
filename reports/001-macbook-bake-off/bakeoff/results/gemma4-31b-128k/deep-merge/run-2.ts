export type PlainObject = Record<string, unknown>;

/**
 * A plain object is a non-null object whose prototype is Object.prototype or null.
 */
function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deeply clones a value. 
 * Plain objects and arrays are copied recursively.
 * Other types (Date, Map, class instances, functions) are kept by reference.
 */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item));
  }

  if (isPlainObject(value)) {
    const result: PlainObject = {};
    for (const key of Object.keys(value)) {
      // Security: skip forbidden keys during cloning
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      result[key] = clone(value[key]);
    }
    return result;
  }

  return value;
}

/**
 * Merges multiple configuration objects from left to right.
 * Later values overwrite earlier ones.
 */
export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    // Safety check for non-object arguments despite the type signature
    if (!isPlainObject(obj)) {
      continue;
    }

    // Object.keys returns own enumerable string keys
    for (const key of Object.keys(obj)) {
      // Security: prevent prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      const incomingValue = obj[key];

      // Incoming undefined is skipped
      if (incomingValue === undefined) {
        continue;
      }

      const existingValue = result[key];

      if (isPlainObject(existingValue) && isPlainObject(incomingValue)) {
        // Recursively merge plain objects
        result[key] = deepMerge(existingValue, incomingValue);
      } else {
        // Replace with a deep clone of the incoming value
        result[key] = clone(incomingValue);
      }
    }
  }

  return result;
}
