export type PlainObject = Record<string, unknown>;

export function deepMerge(...objects: PlainObject[]): PlainObject {
  // Handle no arguments case
  if (objects.length === 0) {
    return {};
  }

  // Create a result object with Object.prototype as prototype
  const result: PlainObject = Object.create(null);

  // Helper function to determine if a value is a plain object
  const isPlainObject = (value: unknown): value is PlainObject => {
    if (value === null || typeof value !== 'object') {
      return false;
    }

    // Get the prototype of the value
    const proto = Object.getPrototypeOf(value);
    
    // Check if prototype is Object.prototype (or null for Object.create(null))
    return proto === Object.prototype || proto === null;
  };

  // Helper to safely merge two plain objects
  const mergePlainObjects = (target: PlainObject, source: PlainObject): PlainObject => {
    // Iterate over all own, enumerable, string keys in source
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        // Skip forbidden keys
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }

        const sourceValue = source[key];
        const targetValue = target[key];

        // Skip undefined values from source
        if (sourceValue === undefined) {
          continue;
        }

        // If both values are plain objects, merge recursively
        if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
          // Ensure we create a new object rather than mutate target
          target[key] = mergePlainObjects(
            isPlainObject(targetValue) ? Object.create(null) : {},
            sourceValue
          );
        } else {
          // Otherwise, replace the target value with source value (including null)
          target[key] = sourceValue;
        }
      }
    }

    return target;
  };

  // Process each object in order
  for (const obj of objects) {
    if (isPlainObject(obj)) {
      mergePlainObjects(result, obj);
    }
  }

  return result;
}
