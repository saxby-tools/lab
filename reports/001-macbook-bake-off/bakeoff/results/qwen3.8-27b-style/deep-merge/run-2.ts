export type PlainObject = Record<string, unknown>;

// Keys that can hijack a prototype chain; they must be
// invisible to every merge and every clone.
const SKIPPED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);


// A "plain object" is a bare data container, not a
// Date, Map, class instance, array, or function.
function isPlainObject(value: unknown): value is PlainObject {
  if (value === null) return false;
  if (typeof value !== "object") return false;

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}


// Deep-copy plain objects and arrays so the result
// shares no reference with any input.  Every other
// type (Date, Map, class instance, function,
// primitive) is kept by reference.
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((el) => cloneValue(el));
  }

  if (isPlainObject(value)) {
    const out: PlainObject = {};
    for (const key of Object.keys(value)) {
      if (SKIPPED_KEYS.has(key)) continue;
      out[key] = cloneValue(value[key]);
    }
    return out;
  }

  return value;
}


export function deepMerge(
  ...objects: PlainObject[]
): PlainObject {
  // No arguments → empty config.
  const result: PlainObject = {};

  for (const obj of objects) {
    for (const key of Object.keys(obj)) {
      if (SKIPPED_KEYS.has(key)) continue;

      const incoming = obj[key];

      // undefined means "no opinion": keep whatever
      // is already in result.  null *does* overwrite.
      if (incoming === undefined) continue;

      const existing = result[key];

      // Recurse only when both sides are plain objects.
      // Arrays, Dates, null, etc. replace outright.
      if (isPlainObject(incoming) && isPlainObject(existing)) {
        result[key] = deepMerge(existing, incoming);
        continue;
      }

      result[key] = cloneValue(incoming);
    }
  }

  return result;
}
