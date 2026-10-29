export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

/**
 * Decodes a query string component.
 * 
 * Replaces '+' with space first, then attempts percent-decoding.
 * If decoding fails, returns the string after '+' replacement.
 */
function safeDecode(str: string): string {
  const replaced = str.replace(/\+/g, ' ');

  try {
    return decodeURIComponent(replaced);
  } catch {
    return replaced;
  }
}

/**
 * Parses a URL query string into a Record.
 */
export function parseQuery(input: string): Query {
  let queryStr = input;

  if (queryStr.startsWith('?')) {
    queryStr = queryStr.slice(1);
  }

  const hashIndex = queryStr.indexOf('#');
  if (hashIndex !== -1) {
    queryStr = queryStr.slice(0, hashIndex);
  }

  const result = Object.create(null);
  const pieces = queryStr.split('&');

  for (const piece of pieces) {
    if (piece === '') {
      continue;
    }

    const eqIndex = piece.indexOf('=');
    const rawKey = eqIndex === -1 ? piece : piece.slice(0, eqIndex);
    const rawVal = eqIndex === -1 ? '' : piece.slice(eqIndex + 1);

    const key = safeDecode(rawKey);
    const val = safeDecode(rawVal);

    if (key === '') {
      continue;
    }

    const existing = result[key];

    if (existing === undefined) {
      result[key] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      result[key] = [existing, val];
    }
  }

  return result;
}

/**
 * Validates if a value is a serializable primitive.
 */
function isValidValue(val: unknown): boolean {
  if (typeof val === 'string') return true;
  if (typeof val === 'number') return true;
  if (typeof val === 'boolean') return true;
  if (typeof val === 'bigint') return true;

  return false;
}

/**
 * Serializes a Record into a URL query string.
 */
export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  const keys = Object.keys(query);

  for (const key of keys) {
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

        if (!isValidValue(item)) {
          throw new TypeError('Invalid value type in array');
        }

        const k = encodeURIComponent(key);
        const v = encodeURIComponent(String(item));
        pairs.push(`${k}=${v}`);
      }

      continue;
    }

    if (!isValidValue(value)) {
      throw new TypeError('Invalid value type');
    }

    const k = encodeURIComponent(key);
    const v = encodeURIComponent(String(value));
    pairs.push(`${k}=${v}`);
  }

  return pairs.join('&');
}
