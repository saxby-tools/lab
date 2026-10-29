export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

/**
 * Parses a URL query string into a Query object.
 * 
 * Handles leading '?', fragments (#), percent-decoding, and duplicate keys.
 * Uses Object.create(null) to ensure prototype safety for keys like __proto__.
 */
export function parseQuery(input: string): Query {
  const result = Object.create(null);

  // 1. Ignore one leading '?'
  let str = input.startsWith('?') ? input.slice(1) : input;

  // 2. Ignore everything after '#'
  const hashIndex = str.indexOf('#');
  if (hashIndex !== -1) {
    str = str.slice(0, hashIndex);
  }

  // 3. Split on '&' and skip empty pieces
  const pieces = str.split('&');

  for (const piece of pieces) {
    if (!piece) continue;

    // 4. Split on the FIRST '='
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

    // 5. Replace '+' with space, then percent-decode
    const decode = (val: string): string => {
      const plusReplaced = val.replace(/\+/g, ' ');
      try {
        return decodeURIComponent(plusReplaced);
      } catch {
        // If decoding fails, return the string as it was after '+' replacement
        return plusReplaced;
      }
    };

    const key = decode(rawKey);
    const value = decode(rawValue);

    // 6. Skip pieces whose decoded key is empty
    if (key === '') continue;

    // 7. Handle single vs multiple values
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Serializes a Query object into a URL query string.
 * 
 * Validates values and encodes keys/values using encodeURIComponent.
 * Throws TypeError for unsupported types.
 */
export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  const keys = Object.keys(query);

  for (const key of keys) {
    const value = query[key];

    // Omit key if value is undefined or null
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      // Process array elements: skip null/undefined, throw on unsupported types
      for (const item of value) {
        if (item === undefined || item === null) continue;
        
        const encodedVal = encodeValue(item);
        pairs.push(`${encodeURIComponent(key)}=${encodedVal}`);
      }
    } else {
      // Process scalar value
      const encodedVal = encodeValue(value);
      pairs.push(`${encodeURIComponent(key)}=${encodedVal}`);
    }
  }

  return pairs.join('&');
}

/**
 * Helper to convert a value to a string and URI encode it.
 * Throws TypeError for objects, functions, or symbols.
 */
function encodeValue(val: unknown): string {
  if (typeof val === 'string') {
    return encodeURIComponent(val);
  }
  if (
    typeof val === 'number' ||
    typeof val === 'boolean' ||
    typeof val === 'bigint'
  ) {
    return encodeURIComponent(String(val));
  }
  
  // Any other type (object, function, symbol) is forbidden
  throw new TypeError(`Unsupported query value type: ${typeof val}`);
}
