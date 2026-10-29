export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function decode(str: string): string {
  const replaced = str.replace(/\+/g, ' ');

  try {
    return decodeURIComponent(replaced);
  } catch {
    return replaced;
  }
}

export function parseQuery(input: string): Query {
  let str = input;

  if (str.startsWith('?')) {
    str = str.slice(1);
  }

  const hashIndex = str.indexOf('#');
  if (hashIndex !== -1) {
    str = str.slice(0, hashIndex);
  }

  const pieces = str.split('&');
  const result = Object.create(null);

  for (const piece of pieces) {
    if (!piece) {
      continue;
    }

    const eqIndex = piece.indexOf('=');
    let rawKey: string;
    let rawValue: string;

    if (eqIndex === -1) {
      rawKey = piece;
      rawValue = '';
    } else {
      rawKey = piece.slice(0, eqIndex);
      rawValue = piece.slice(eqIndex + 1);
    }

    const key = decode(rawKey);
    const value = decode(rawValue);

    if (!key) {
      continue;
    }

    const existing = result[key];

    if (existing === undefined) {
      result[key] = value;
      continue;
    }

    if (typeof existing === 'string') {
      result[key] = [existing, value];
      continue;
    }

    existing.push(value);
  }

  return result;
}

function stringifyValue(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }

  if (typeof val === 'number') {
    return String(val);
  }

  if (typeof val === 'boolean') {
    return String(val);
  }

  if (typeof val === 'bigint') {
    return String(val);
  }

  throw new TypeError('Unsupported query value type');
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    if (value === null) {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null) {
          continue;
        }

        if (item === undefined) {
          continue;
        }

        const encodedKey = encodeURIComponent(key);
        const encodedVal = encodeURIComponent(stringifyValue(item));
        pairs.push(`${encodedKey}=${encodedVal}`);
      }

      continue;
    }

    const encodedKey = encodeURIComponent(key);
    const encodedVal = encodeURIComponent(stringifyValue(value));
    pairs.push(`${encodedKey}=${encodedVal}`);
  }

  return pairs.join('&');
}
