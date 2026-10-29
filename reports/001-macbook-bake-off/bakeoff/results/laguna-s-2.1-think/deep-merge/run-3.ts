export type PlainObject = Record<string, unknown>;

/**
 * Determines whether a value is a plain object. A plain object is a non-null
 * object whose prototype is Object.prototype or null. Arrays, Dates, Maps,
 * class instances, and functions are not considered plain objects.
 *
 * @param value - The value to check.
 * @returns True if the value is a plain object, false otherwise.
 */
function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks whether a key should be skipped. These keys are __proto__,
 * constructor, and prototype, which could otherwise modify prototypes.
 *
 * @param key - The key to check.
 * @returns True if the key should be skipped, false otherwise.
 */
function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Creates a shallow clone of a plain object or array, ensuring all values
 * are cloned deeply when necessary. Only processes own enumerable string keys.
 *
 * @param source - The source object or array to clone.
 * @returns A new plain object or array with cloned values.
 */
function cloneDeep<T>(source: T): T {
  if (!isPlainObject(source) && !Array.isArray(source)) {
    // For non-plain objects (Date, Map, etc.), keep the reference
    return source;
  }

  if (Array.isArray(source)) {
    // Clone arrays recursively
    const clonedArray: unknown[] = [];
    for (const item of source) {
      clonedArray.push(cloneDeep(item));
    }
    return clonedArray as unknown as T;
  }

  // Clone plain objects recursively
  const clonedObject: PlainObject = {};
  for (const key of Reflect.ownKeys(source) as string[]) {
    if (typeof key !== "string" || isUnsafeKey(key)) {
      continue;
    }
    clonedObject[key] = cloneDeep((source as PlainObject)[key]);
  }
  return clonedObject as unknown as T;
}

/**
 * Deeply merges an arbitrary number of plain objects, with later values
 * taking precedence over earlier ones. This function does not mutate its
 * arguments and ensures the result shares no references with any argument.
 *
 * @param objects - The objects to merge, ordered by priority from lowest to highest.
 * @returns A new plain object that is the result of deeply merging all inputs.
 */
export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    if (!isPlainObject(obj)) {
      continue;
    }

    for (const key of Reflect.ownKeys(obj) as string[]) {
      if (typeof key !== "string" || isUnsafeKey(key)) {
        continue;
      }

      const value = obj[key];

      // Incoming undefined is skipped
      if (value === undefined) {
        continue;
      }

      const existing = result[key];

      // If both existing and incoming values are plain objects, merge recursively
      if (isPlainObject(existing) && isPlainObject(value)) {
        result[key] = deepMerge(existing, value);
      } else {
        // Otherwise, replace the value entirely, cloning if necessary
        result[key] = cloneDeep(value);
      }
    }
  }

  return result;
}
