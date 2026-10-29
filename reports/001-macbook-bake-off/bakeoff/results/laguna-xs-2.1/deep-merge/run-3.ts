export type PlainObject = Record<string, unknown>;

const SAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function deepClone(value: unknown): unknown {
  if (isPlainObject(value)) {
    const result: PlainObject = {};
    for (const key of Object.keys(value)) {
      if (!SAFE_KEYS.has(key)) {
        result[key] = deepClone(value[key]);
      }
    }
    return result;
  } else if (Array.isArray(value)) {
    return value.map(item => deepClone(item));
  } else {
    return value;
  }
}

function deepMergeObjects(target: PlainObject, source: PlainObject): PlainObject {
  const result: PlainObject = {};

  for (const key of Object.keys(target)) {
    if (!SAFE_KEYS.has(key)) {
      result[key] = deepClone(target[key]);
    }
  }

  for (const key of Object.keys(source)) {
    if (SAFE_KEYS.has(key)) {
      continue;
    }

    const sourceValue = source[key];

    if (sourceValue === undefined) {
      continue;
    }

    const existingValue = result[key];

    if (isPlainObject(existingValue) && isPlainObject(sourceValue)) {
      result[key] = deepMergeObjects(existingValue, sourceValue);
    } else {
      result[key] = deepClone(sourceValue);
    }
  }

  return result;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  if (objects.length === 0) {
    return {};
  }

  let result: PlainObject = {};

  for (const obj of objects) {
    result = deepMergeObjects(result, obj);
  }

  return result;
}
