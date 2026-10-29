export type PlainObject = Record<string, unknown>;

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function copyArray(arr: unknown[]): unknown[] {
  return arr.map((item) => {
    if (isPlainObject(item)) return deepMerge(item);
    if (Array.isArray(item)) return copyArray(item);
    return item; // Keep references for other types (Date, Map, etc.)
  });
}

function deepClone(value: unknown): unknown {
  if (isPlainObject(value)) return deepMerge(value);
  if (Array.isArray(value)) return copyArray(value);
  return value;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;

    for (const key of Object.keys(obj)) {
      if (unsafeKeys.has(key)) continue;

      const incoming = obj[key];

      if (incoming === undefined) continue;

      const current = result[key];

      if (isPlainObject(current) && isPlainObject(incoming)) {
        result[key] = deepMerge(current, incoming);
      } else if (Array.isArray(incoming)) {
        result[key] = copyArray(incoming);
      } else if (isPlainObject(incoming)) {
        result[key] = deepMerge(incoming);
      } else {
        result[key] = deepClone(incoming);
      }
    }
  }

  return result;
}
