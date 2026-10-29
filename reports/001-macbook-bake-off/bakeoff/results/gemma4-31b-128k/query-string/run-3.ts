export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

/**
 * Parses a URL query string into a Query object.
 * 
 * Handles edge cases like prototype pollution, malformed percent-encoding,
 * and mixed single/multiple values for the same key.
 */
export function parseQuery(input: string): Query {
  let queryStr = input;

  // 1. Ignore one leading '?'
  if (queryStr.startsWith('?')) {
    queryStr = queryStr.slice(1);
  }

  // 2. Ignore '#' and everything after it
  const hashIndex = queryStr.indexOf('#');
  if (hashIndex !== -1) {
    queryStr = queryStr.slice(0, hashIndex);
  }

  // 3. Split on '&' and skip empty pieces
  const pieces = queryStr.split('&').filter((piece) => piece.length > 0);

  // Use Object.create(null) to ensure no prototype properties interfere (e.g., __proto__)
  const result = Object.create(null) as Query;

  for (const piece of pieces) {
    // 4. Split each piece on its FIRST '='
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

    // 5. Decode: Replace '+' with space, then percent-decode.
    // If percent-decoding fails, keep the string as it was after '+' replacement.
    const decode = (s: string): string => {
      const replaced = s.replace(/\+/g, ' ');
      try {
        return decodeURIComponent(replaced);
      } catch {
        return replaced;
      }
    };

    const key = decode(rawKey);
    const value = decode(rawValue);

    // 6. Skip pieces whose decoded key is empty
    if (key === '') {
      continue;
    }

    // 7. Map keys to string or array of strings
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = value;
    } else {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    }
  }

  return result;
}

/**
 * Serializes a query object into a URL query string.
 * 
 * Supports strings, numbers, booleans, and bigints. 
 * Arrays are expanded into multiple pairs.
 */
export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  const keys = Object.keys(query);

  for (const key of keys) {
    const value = query[key];

    // A value of undefined or null omits the key
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      // An array produces one key=value pair per element, skipping null/undefined
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        const serializedItem = validateAndStringify(item);
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializedItem)}`);
      }
    } else {
      const serializedValue = validateAndStringify(value);
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializedValue)}`);
    }
  }

  return pairs.join('&');
}

/**
 * Helper to validate that a value is a primitive supported by the spec
 * and convert it to its string representation.
 */
function validateAndStringify(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }
  if (
    typeof val === 'number' ||
    typeof val === 'boolean' ||
    typeof val === 'bigint'
  ) {
    return String(val);
  }
  // Throws TypeError for plain objects, functions, symbols, etc.
  throw new TypeError(
    `Unsupported value type for query string: ${typeof val}`,
  );
}
