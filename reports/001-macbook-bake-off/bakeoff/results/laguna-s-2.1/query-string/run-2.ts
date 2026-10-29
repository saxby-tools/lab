export type QueryValue = string | string[];
export type Query = Record<string, QueryValue>;

function safeDecodeURIComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

export function parseQuery(input: string): Query {
  const result: Query = Object.create(null) as Query;

  // Truncate at first '#'
  const hashIndex = input.indexOf('#');
  if (hashIndex !== -1) {
    input = input.slice(0, hashIndex);
  }

  // Remove leading '?'
  if (input.startsWith('?')) {
    input = input.slice(1);
  }

  if (input === '') {
    return result;
  }

  const pairs = input.split('&');

  for (const pair of pairs) {
    if (pair === '') {
      continue;
    }

    let key: string;
    let value: string;

    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      key = pair;
      value = '';
    } else {
      key = pair.slice(0, eqIndex);
      value = pair.slice(eqIndex + 1);
    }

    const decodedKey = safeDecodeURIComponent(key.replace(/\+/g, ' '));
    if (decodedKey === '') {
      continue;
    }

    const decodedValue = safeDecodeURIComponent(value.replace(/\+/g, ' '));

    if (Object.prototype.hasOwnProperty.call(result, decodedKey)) {
      const existing = result[decodedKey];
      if (Array.isArray(existing)) {
        existing.push(decodedValue);
      } else {
        result[decodedKey] = [existing, decodedValue];
      }
    } else {
      Object.defineProperty(result, decodedKey, {
        value: decodedValue,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  return result;
}

function isValidValue(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  const keys = Object.keys(query);

  for (const key of keys) {
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
        if (!isValidValue(item)) {
          throw new TypeError('Invalid value in array');
        }
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      if (!isValidValue(value)) {
        throw new TypeError('Invalid value');
      }
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return pairs.join('&');
}
