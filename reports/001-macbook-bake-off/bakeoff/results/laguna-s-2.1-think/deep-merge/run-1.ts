export type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  if (isPlainObject(value)) {
    const clone: PlainObject = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      clone[key] = deepClone((value as PlainObject)[key]);
    }
    return clone;
  }
  return value;
}

function deepMergeInto(target: PlainObject, source: PlainObject): void {
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    const incoming = source[key];
    if (incoming === undefined) continue;

    const existing = target[key];

    if (isPlainObject(existing) && isPlainObject(incoming)) {
      deepMergeInto(existing, incoming);
    } else {
      target[key] = deepClone(incoming);
    }
  }
}

export function deepMerge(...objects: PlainObject[]): PlainObject {
  const result: PlainObject = {};
  for (const obj of objects) {
    deepMergeInto(result, obj);
  }
  return result;
}
