export type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

const canMerge = (value: unknown): boolean => {
  return isPlainObject(value) || Array.isArray(value);
};

const copyValue = (value: unknown): unknown => {
  if (isPlainObject(value)) {
    const result: PlainObject = {};
    for (const key in value) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const val = value[key];
        result[key] = canMerge(val) ? copyValue(val) : val;
      }
    }
    return result;
  } else if (Array.isArray(value)) {
    return value.map((item) => (canMerge(item) ? copyValue(item) : item));
  }
  return value;
};

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    if (obj === null || obj === undefined) {
      continue;
    }

    for (const key in obj) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        continue;
      }

      const value = obj[key];

      if (value === undefined) {
        continue;
      }

      const existing = result[key];

      if (isPlainObject(existing) && isPlainObject(value)) {
        result[key] = deepMerge(existing, value);
      } else {
        result[key] = copyValue(value);
      }
    }
  }

  return result;
}
