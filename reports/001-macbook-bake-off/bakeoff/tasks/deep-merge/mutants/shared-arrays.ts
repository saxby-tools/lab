// ---- Constants --------------------------------------------------------

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ---- Types ------------------------------------------------------------

export type PlainObject = Record<string, unknown>;

// ---- Helpers ----------------------------------------------------------

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null) {
    return false;
  }

  if (typeof value !== "object") {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }

  if (isPlainObject(value)) {
    return mergeInto({}, value);
  }

  return value;
}

function mergeInto(target: PlainObject, source: PlainObject): PlainObject {
  for (const key of Object.keys(source)) {
    if (BLOCKED_KEYS.has(key)) {
      continue;
    }

    const incoming = source[key];

    if (incoming === undefined) {
      continue;
    }

    const existing = target[key];

    if (isPlainObject(existing) && isPlainObject(incoming)) {
      target[key] = mergeInto(existing, incoming);
      continue;
    }

    target[key] = copyValue(incoming);
  }

  return target;
}

// ---- Merge ------------------------------------------------------------

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};

  for (const object of objects) {
    mergeInto(result, object);
  }

  return result;
}
