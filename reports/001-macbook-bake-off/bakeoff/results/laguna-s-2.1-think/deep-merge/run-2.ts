export type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneDeep<T>(value: T): T {
  if (isPlainObject(value)) {
    const copy: PlainObject = {};
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      copy[key] = cloneDeep((value as PlainObject)[key]);
    }
    return copy as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeep(item)) as unknown as T;
  }
  return value;
}

function createResult(
  target: PlainObject | undefined,
  source: PlainObject,
): PlainObject {
  if (!isPlainObject(target)) {
    target = {};
  }
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const sourceValue = source[key];
    if (sourceValue === undefined) {
      continue;
    }
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      target[key] = createResult(targetValue, sourceValue);
    } else {
      target[key] = cloneDeep(sourceValue);
    }
  }
  return target;
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  if (objects.length === 0) {
    return {};
  }
  let result: PlainObject | undefined;
  for (const obj of objects) {
    if (isPlainObject(obj)) {
      result = createResult(result, obj);
    }
  }
  return result ?? {};
}
