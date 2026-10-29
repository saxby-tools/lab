export type PlainObject = Record<string, unknown>;

const SAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function copyValue(value: PlainObject | unknown[]): PlainObject | unknown[] {
  if (isArray(value)) {
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (isPlainObject(item)) {
        arr[i] = deepMerge({}, item as PlainObject);
      } else if (isArray(item)) {
        arr[i] = copyValue(item as unknown[]);
      } else {
        arr[i] = item;
      }
    }
    return arr;
  } else {
    const result: PlainObject = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (SAFE_KEYS.has(key)) {
        continue;
      }
      const val = (value as PlainObject)[key];
      if (isPlainObject(val)) {
        result[key] = deepMerge({}, val);
      } else if (isArray(val)) {
        result[key] = copyValue(val as unknown[]);
      } else {
        result[key] = val;
      }
    }
    return result;
  }
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  if (objects.length === 0) {
    return {};
  }

  const result: PlainObject = {};

  for (let objIndex = 0; objIndex < objects.length; objIndex++) {
    const source = objects[objIndex];
    if (source === undefined || source === null) {
      continue;
    }

    const keys = Object.keys(source);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = keys[keyIndex];

      if (SAFE_KEYS.has(key)) {
        continue;
      }

      const sourceValue = source[key];
      const targetValue = result[key];

      if (sourceValue === undefined) {
        continue;
      }

      if (sourceValue === null) {
        result[key] = null;
        continue;
      }

      if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
        result[key] = deepMerge(targetValue, sourceValue);
        continue;
      }

      if (isPlainObject(sourceValue)) {
        result[key] = copyValue(sourceValue);
        continue;
      }

      if (isArray(sourceValue)) {
        result[key] = copyValue(sourceValue);
        continue;
      }

      result[key] = sourceValue;
    }
  }

  return result;
}
