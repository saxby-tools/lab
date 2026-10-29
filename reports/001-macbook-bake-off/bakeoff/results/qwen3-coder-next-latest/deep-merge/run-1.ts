export type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSkipKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function copyObject<T extends PlainObject>(obj: T): T {
  const result: PlainObject = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Skip prototype-altering keys
    if (isSkipKey(key)) continue;
    
    // Handle plain objects and arrays recursively
    if (isPlainObject(value)) {
      result[key] = copyObject(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (isPlainObject(item)) {
          return copyObject(item);
        }
        // For arrays containing non-plain objects (e.g., Date, Map), keep by reference
        return item;
      });
    } else {
      // Keep other values (including undefined and null) as is
      result[key] = value;
    }
  }
  
  return result as T;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  if (objects.length === 0) {
    return {};
  }

  // Create a fresh copy of the first object
  const result: PlainObject = {};
  
  // Process each object left to right
  for (const obj of objects) {
    if (obj == null || typeof obj !== 'object') {
      continue;
    }

    // Skip if the object is not a plain object
    if (!isPlainObject(obj)) {
      continue;
    }

    // Process each key in the current object
    for (const key of Object.keys(obj)) {
      // Skip prototype-altering keys
      if (isSkipKey(key)) continue;

      const incomingValue = obj[key];

      // If incoming value is undefined, skip it (don't overwrite existing)
      if (incomingValue === undefined) {
        continue;
      }

      // Check if we have an existing value at this key
      const existingValue = result[key];

      // If both existing and incoming are plain objects, merge recursively
      if (isPlainObject(existingValue) && isPlainObject(incomingValue)) {
        // Recursively merge nested objects, but only if the existing value is also a plain object
        result[key] = deepMerge(existingValue, incomingValue);
      } else {
        // Otherwise, replace with the incoming value
        // For arrays and other non-plain objects, replace the existing value
        result[key] = incomingValue;
      }
    }
  }

  // Ensure the result object itself has Object.prototype as its prototype
  return Object.create(Object.prototype, Object.getOwnPropertyDescriptors(result));
}
