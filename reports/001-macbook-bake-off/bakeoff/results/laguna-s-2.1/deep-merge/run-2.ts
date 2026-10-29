export type PlainObject = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (isPlainObject(value)) {
    const result: PlainObject = Object.create(null);
    for (const key of Object.keys(value)) {
      if (!FORBIDDEN_KEYS.has(key)) {
        result[key] = clone(value[key]);
      }
    }
    return Object.setPrototypeOf(result, Object.prototype);
  }
  return value;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};
  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const incoming = obj[key];
      if (incoming === undefined) continue;
      const existing = result[key];
      if (isPlainObject(existing) && isPlainObject(incoming)) {
        result[key] = deepMerge(existing, incoming as PlainObject);
      } else {
        result[key] = clone(incoming);
      }
    }
  }
  return result;
}
