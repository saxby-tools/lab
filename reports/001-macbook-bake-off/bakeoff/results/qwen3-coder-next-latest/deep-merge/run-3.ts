export type PlainObject = Record<string, unknown>;

/**
 * Deep merge plain objects, with later values winning.
 * 
 * @param objects - Objects to merge, left to right.
 * @returns A new plain object with deeply merged properties.
 */
export function deepMerge(...objects: PlainObject[]): PlainObject {
  if (objects.length === 0) {
    return {};
  }

  // Helper to determine if a value is a plain object
  const isPlainObject = (value: unknown): value is PlainObject => {
    if (value === null || typeof value !== 'object') {
      return false;
    }
    // Check prototype is Object.prototype or null
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };

  // Helper to safely copy a plain object without mutating original
  const copyPlainObject = (obj: PlainObject): PlainObject => {
    const result: PlainObject = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        // Skip protected keys
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        const value = obj[key];
        // If it's a plain object, copy it recursively
        if (isPlainObject(value)) {
          result[key] = copyPlainObject(value);
        } else if (Array.isArray(value)) {
          // Arrays are copied element-by-element (but not deeply merged by default)
          result[key] = value.map(item => {
            if (isPlainObject(item)) {
              return copyPlainObject(item);
            } else if (Array.isArray(item)) {
              return item.map(i => isPlainObject(i) ? copyPlainObject(i) : i);
            } else {
              // Keep non-plain objects (including Date, Map, etc.) by reference
              return item;
            }
          });
        } else {
          // For other values (including Date, Map, class instances, functions), keep by reference
          result[key] = value;
        }
      }
    }
    return result;
  };

  // Helper to perform the deep merge
  const mergeInto = (target: PlainObject, source: PlainObject): PlainObject => {
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        // Skip protected keys
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }

        const sourceValue = source[key];
        
        // Skip undefined values (but not null)
        if (sourceValue === undefined) {
          continue;
        }

        // If key exists in target and both values are plain objects, merge recursively
        if (Object.prototype.hasOwnProperty.call(target, key)) {
          const targetValue = target[key];
          if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
            // Merge recursively into a copy to avoid mutation
            const merged = mergeInto(copyPlainObject(targetValue), sourceValue);
            target[key] = merged;
          } else {
            // Otherwise, source value replaces target value
            // Make sure to copy the source if it's a plain object
            target[key] = isPlainObject(sourceValue) ? copyPlainObject(sourceValue) : sourceValue;
          }
        } else {
          // New key, add it (copying plain objects)
          target[key] = isPlainObject(sourceValue) ? copyPlainObject(sourceValue) : sourceValue;
        }
      }
    }
    return target;
  };

  // Start with the first object as the base (we'll make a copy to avoid mutations)
  const result = copyPlainObject(objects[0]);
  
  // Merge remaining objects
  for (let i = 1; i < objects.length; i++) {
    // Merge each object into a copy of result to avoid mutation
    const sourceCopy = copyPlainObject(objects[i]);
    mergeInto(result, sourceCopy);
  }

  return result;
}
