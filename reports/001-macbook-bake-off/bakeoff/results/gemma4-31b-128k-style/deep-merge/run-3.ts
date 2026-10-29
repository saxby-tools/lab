export type PlainObject = Record<string, unknown>;

const FORBIDDEN_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * Determines if a value is a plain object.
 * A plain object is defined as a non-null object whose prototype is
 * either Object.prototype or null.
 */
function isPlainObject(val: unknown): boolean {
  if (typeof val !== "object") {
    return false;
  }

  if (val === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(val);

  return proto === Object.prototype || proto === null;
}

/**
 * Creates a deep copy of the value.
 * Plain objects and arrays are recursively copied to ensure the result
 * shares no references with the input. Other objects are kept by reference.
 * Forbidden keys are omitted from plain objects.
 */
function deepClone(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => deepClone(item));
  }

  if (!isPlainObject(val)) {
    return val;
  }

  const clone: PlainObject = {};

  for (const key in val) {
    if (!Object.hasOwn(val, key)) {
      continue;
    }

    if (FORBIDDEN_KEYS.includes(key)) {
      continue;
    }

    clone[key] = deepClone(val[key]);
  }

  return clone;
}

/**
 * Merges two objects.
 * If both values are plain objects, they are merged recursively.
 * Otherwise, the source value replaces the target value.
 * Undefined values in the source are ignored.
 */
function mergeTwo(target: PlainObject, source: PlainObject): PlainObject {
  const result: PlainObject = { ...target };

  for (const key in source) {
    if (!Object.hasOwn(source, key)) {
      continue;
    }

    if (FORBIDDEN_KEYS.includes(key)) {
      continue;
    }

    const sVal = source[key];

    if (sVal === undefined) {
      continue;
    }

    const tVal = target[key];

    if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = mergeTwo(tVal, sVal);
      continue;
    }

    result[key] = deepClone(sVal);
  }

  return result;
}

/**
 * Deeply merges multiple configuration objects from left to right.
 * Later objects overwrite values from earlier ones.
 * The returned object is a fresh copy with no shared references to
 * plain objects or arrays found in the arguments.
 */
export function deepMerge(...objects: PlainObject[]): PlainObject {
  let result: PlainObject = {};

  for (const obj of objects) {
    result = mergeTwo(result, obj);
  }

  return result;
}
