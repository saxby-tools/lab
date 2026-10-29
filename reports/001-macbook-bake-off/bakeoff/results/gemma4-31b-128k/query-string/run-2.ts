export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

/**
 * Parses a URL query string into an object.
 * 
 * @param input The query string to parse.
 * @returns A Record where keys map to either a single string or an array of strings.
 */
export function parseQuery(input: string): Query {
  let str = input;

  // Ignore one leading '?'
  if (str.startsWith('?')) {
    str = str.slice(1);
  }

  // Ignore '#' and everything after it
  const hashIndex = str.indexOf('#');
  if (hashIndex !== -1) {
    str = str.slice(0, hashIndex);
  }

  // Split on '&' and skip empty pieces
  const pieces = str.split('&');
  
  // Use Object.create(null) to avoid prototype pollution and 
  // ensure keys like __proto__ are treated as own properties.
  const result = Object.create(null) as Query;

  for (const piece of pieces) {
    if (!piece) continue;

    // Split on the FIRST '='
    const eqIndex = piece.indexOf('=');
    let rawKey: string;
    let rawValue: string;

    if (eqIndex === -1) {
      rawKey = piece;
      rawValue = "";
    } else {
      rawKey = piece.slice(0, eqIndex);
      rawValue = piece.slice(eqIndex + 1);
    }

    const decode = (s: string): string => {
      // Replace '+' with space first
      const plusReplaced = s.replace(/\+/g, ' ');
      try {
        return decodeURIComponent(plusReplaced);
      } catch {
        // If percent-decoding fails, return the string after '+' replacement
        return plusReplaced;
      }
    };

    const key = decode(rawKey);
    const value = decode(rawValue);

    // Skip pieces whose decoded key is empty
    if (key === "") continue;

    if (!(key in result)) {
      // First appearance of this key
      result[key] = value;
    } else {
      // Subsequent appearances: convert to array or push to existing array
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
 * Serializes an object into a URL query string.
 * 
 * @param query The object to serialize.
 * @throws TypeError If a value is encountered that is not a string, number, boolean, bigint, or array of these.
 * @returns The serialized query string.
 */
export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  const keys = Object.keys(query);

  const validateAndStringify = (val: unknown): string => {
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
    throw new TypeError(`Unsupported value type: ${typeof val}`);
  };

  for (const key of keys) {
    const value = query[key];

    // A value of undefined or null omits the key
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      // An array produces one key=value pair per element
      for (const item of value) {
        // undefined and null elements are skipped
        if (item === undefined || item === null) {
          continue;
        }
        const serializedVal = validateAndStringify(item);
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializedVal)}`);
      }
    } else {
      // Single value
      const serializedVal = validateAndStringify(value);
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializedVal)}`);
    }
  }

  return pairs.join('&');
}
