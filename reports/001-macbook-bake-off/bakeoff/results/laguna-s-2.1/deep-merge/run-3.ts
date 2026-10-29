export type PlainObject = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }
  if (isPlainObject(value)) {
    const clone: PlainObject = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }
      clone[key] = deepClone(value[key]);
    }
    return clone;
  }
  return value;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  if (objects.length === 0) {
    return {};
  }

  const result: PlainObject = {};

  for (const obj of objects) {
    if (!isPlainObject(obj)) {
      continue;
    }
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }

      const value = obj[key];

      if (value === undefined) {
        continue;
      }

      const currentValue = result[key];

      if (value === null) {
        result[key] = null;
      } else if (Array.isArray(value)) {
        result[key] = deepClone(value);
      } else if (isPlainObject(value)) {
        if (isPlainObject(currentValue)) {
          result[key] = deepMerge(currentValue, value);
        } else {
          result[key] = deepClone(value);
        }
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}
