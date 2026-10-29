export type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepCopy(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => deepCopy(item));
  }

  if (isPlainObject(value)) {
    const out: PlainObject = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        continue;
      }
      out[key] = deepCopy(value[key]);
    }
    return out;
  }

  // Date, Map, Set, class instances, functions, etc. — keep by reference.
  return value;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    if (obj === null || obj === undefined) continue;

    const keys = Object.keys(obj);
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j];

      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        continue;
      }

      const incoming = obj[key];

      // undefined incoming is skipped so the existing value is preserved.
      if (incoming === undefined) continue;

      const existing = result[key];

      if (isPlainObject(incoming) && isPlainObject(existing)) {
        result[key] = deepMerge(existing, incoming);
      } else {
        // null, arrays, Dates, Maps, functions, primitives,
        // or a plain object replacing a non-plain existing value.
        result[key] = deepCopy(incoming);
      }
    }
  }

  return result;
}
