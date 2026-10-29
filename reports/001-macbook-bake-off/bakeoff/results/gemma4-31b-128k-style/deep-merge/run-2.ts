export type PlainObject = Record<string, unknown>;

const FORBIDDEN_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
];

export function isPlainObject(val: unknown): boolean {
  if (val === null) {
    return false;
  }

  if (typeof val !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(val);

  return proto === Object.prototype || proto === null;
}

function deepClone(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(deepClone);
  }

  if (!isPlainObject(val)) {
    return val;
  }

  const clone: PlainObject = {};

  for (const key of Object.keys(val)) {
    clone[key] = deepClone((val as PlainObject)[key]);
  }

  return clone;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    if (!isPlainObject(obj)) {
      continue;
    }

    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        continue;
      }

      const value = obj[key];

      if (value === undefined) {
        continue;
      }

      const existing = result[key];

      if (!isPlainObject(existing)) {
        result[key] = deepClone(value);
        continue;
      }

      if (!isPlainObject(value)) {
        result[key] = deepClone(value);
        continue;
      }

      result[key] = deepMerge(existing as PlainObject, value as PlainObject);
    }
  }

  return result;
}
