export type PlainObject = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);


function isPlainObject(val: unknown): val is PlainObject {
  if (val === null) {
    return false;
  }

  if (typeof val !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(val);

  return proto === Object.prototype || proto === null;
}


function deepClone(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => deepClone(item));
  }

  if (isPlainObject(val)) {
    const clone: PlainObject = {};

    for (const key of Object.keys(val)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }

      clone[key] = deepClone(val[key]);
    }

    return clone;
  }

  return val;
}


function mergeTwo(target: PlainObject, source: PlainObject): PlainObject {
  const result: PlainObject = { ...target };

  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }

    const sourceValue = source[key];

    // Incoming undefined values are skipped to preserve existing values
    if (sourceValue === undefined) {
      continue;
    }

    const targetValue = target[key];

    if (
      isPlainObject(sourceValue) &&
      isPlainObject(targetValue)
    ) {
      result[key] = mergeTwo(targetValue, sourceValue);
      continue;
    }

    // Arrays and other primitives are replaced entirely
    result[key] = deepClone(sourceValue);
  }

  return result;
}


export function deepMerge(...objects: PlainObject[]): PlainObject {
  let result: PlainObject = {};

  for (const obj of objects) {
    result = mergeTwo(result, obj);
  }

  return result;
}
