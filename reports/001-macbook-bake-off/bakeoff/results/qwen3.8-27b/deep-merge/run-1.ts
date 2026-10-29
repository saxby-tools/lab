export type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSkippedKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function deepClone(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (isPlainObject(value)) {
    const out: PlainObject = {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (isSkippedKey(key)) continue;
      out[key] = deepClone(value[key]);
    }
    return out;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = deepClone(value[i]);
    }
    return out;
  }

  // Date, Map, Set, class instances, functions, primitives — keep by reference.
  return value;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (let s = 0; s < objects.length; s++) {
    const source = objects[s];
    if (source === null || source === undefined) continue;

    const keys = Object.keys(source);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (isSkippedKey(key)) continue;

      const incoming = source[key];
      if (incoming === undefined) continue;

      const existing = result[key];

      if (isPlainObject(existing) && isPlainObject(incoming)) {
        result[key] = deepMerge(existing, incoming);
      } else {
        result[key] = deepClone(incoming);
      }
    }
  }

  return result;
}
