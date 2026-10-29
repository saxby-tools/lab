export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function tryPercentDecode(str: string): string {
  try {
    // Temporarily replace '+' with space, then decode
    // encodeURIComponent does not encode '/', but decodeURIComponent does not handle '+'
    const decoded = decodeURIComponent(str.replace(/\+/g, ' '));
    return decoded;
  } catch {
    return str.replace(/\+/g, ' ');
  }
}

export function parseQuery(input: string): Query {
  let working = input;

  // Remove fragment (everything from first '#' onward)
  const hashIndex = working.indexOf('#');
  if (hashIndex !== -1) {
    working = working.slice(0, hashIndex);
  }

  // Remove a single leading '?'
  if (working.startsWith('?')) {
    working = working.slice(1);
  }

  const result: Query = {};

  if (working === '') {
    return result;
  }

  const pieces = working.split('&');

  for (const piece of pieces) {
    if (piece === '') {
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

    const decodedKey = tryPercentDecode(rawKey);
    if (decodedKey === '') {
      continue;
    }

    const decodedValue = tryPercentDecode(rawValue);

    if (Object.prototype.hasOwnProperty.call(result, decodedKey)) {
      const existing = result[decodedKey];
      if (Array.isArray(existing)) {
        existing.push(decodedValue);
      } else {
        result[decodedKey] = [existing, decodedValue];
      }
    } else {
      result[decodedKey] = decodedValue;
    }
  }

  return result;
}

function encodeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return undefined as unknown as string;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new TypeError(`Invalid value type for serialization: ${typeof value}`);
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        const encodedItem = encodeValue(item);
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(encodedItem));
      }
    } else {
      const encodedValue = encodeValue(value);
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(encodedValue));
    }
  }

  return pairs.join('&');
}
