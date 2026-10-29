export type QueryValue = string | string[];
export type Query = Record<string, QueryValue>;

function decodePercent(str: string): string {
  try {
    const decoded = decodeURIComponent(str);
    // Check for lone surrogates or other invalid UTF-8 sequences
    const bytes = new TextEncoder().encode(decoded);
    const text = new TextDecoder().decode(bytes);
    if (text.includes('\uFFFD') && !decoded.includes('\uFFFD')) {
      throw new Error('Invalid UTF-8 sequence');
    }
    return text;
  } catch {
    return str;
  }
}

export function parseQuery(input: string): Query {
  const query: Query = Object.create(null);

  let str = input;
  // Strip leading '?'
  if (str.startsWith('?')) {
    str = str.slice(1);
  }

  // Cut off fragment
  const hashIndex = str.indexOf('#');
  if (hashIndex !== -1) {
    str = str.slice(0, hashIndex);
  }

  if (str === '') {
    return query;
  }

  const pieces = str.split('&');
  for (const piece of pieces) {
    if (piece === '') {
      continue;
    }

    const eqIndex = piece.indexOf('=');
    let keyRaw: string;
    let valueRaw: string;

    if (eqIndex === -1) {
      keyRaw = piece;
      valueRaw = '';
    } else {
      keyRaw = piece.slice(0, eqIndex);
      valueRaw = piece.slice(eqIndex + 1);
    }

    // Replace '+' with space first, then percent-decode
    const key = decodePercent(keyRaw.replace(/\+/g, ' '));
    const value = decodePercent(valueRaw.replace(/\+/g, ' '));

    if (key === '') {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(query, key)) {
      const existing = query[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    } else {
      query[key] = value;
    }
  }

  return query;
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const keys = Object.keys(query);
  const pairs: string[] = [];

  for (const key of keys) {
    const value = query[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializeValue(item))}`);
      }
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializeValue(value))}`);
    }
  }

  return pairs.join('&');
}

function serializeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new TypeError(`Invalid query value type: ${typeof value}`);
}
