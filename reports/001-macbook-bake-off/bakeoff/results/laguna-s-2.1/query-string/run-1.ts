export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseQuery(input: string): Query {
  const result: Query = {};
  if (!input) return result;

  let s = input;
  if (s[0] === '?') s = s.slice(1);
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) s = s.slice(0, hashIdx);

  if (!s) return result;

  const pairs = s.split('&');
  for (const pair of pairs) {
    if (!pair) continue;
    let keyPart: string;
    let valPart: string;
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      keyPart = pair;
      valPart = '';
    } else {
      keyPart = pair.slice(0, eqIdx);
      valPart = pair.slice(eqIdx + 1);
    }

    const decodedKey = decode(keyPart.replace(/\+/g, ' '));
    if (!decodedKey) continue;

    const decodedVal = decode(valPart.replace(/\+/g, ' '));

    if (decodedKey in result) {
      const existing = result[decodedKey];
      if (Array.isArray(existing)) {
        existing.push(decodedVal);
      } else {
        result[decodedKey] = [existing, decodedVal];
      }
    } else {
      result[decodedKey] = decodedVal;
    }
  }

  return result;
}

function isValidValue(v: unknown): v is string | number | boolean | bigint {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  );
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value == null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        if (!isValidValue(item)) {
          throw new TypeError('Invalid query value');
        }
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }

    if (!isValidValue(value)) {
      throw new TypeError('Invalid query value');
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }

  return parts.join('&');
}
