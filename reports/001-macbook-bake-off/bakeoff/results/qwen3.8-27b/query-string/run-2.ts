export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function hexVal(c: number): number | null {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return null;
}

function safePercentDecode(input: string): string | null {
  const bytes: number[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const c = input.charCodeAt(i);
    if (c === 37) {
      // %XX
      if (i + 2 >= len) return null;
      const h1 = hexVal(input.charCodeAt(i + 1));
      const h2 = hexVal(input.charCodeAt(i + 2));
      if (h1 === null || h2 === null) return null;
      bytes.push(h1 * 16 + h2);
      i += 3;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate – needs a following low surrogate
      if (i + 1 >= len) return null;
      const low = input.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return null;
      const cp = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
      bytes.push(
        0xf0 | (cp >>> 18),
        0x80 | ((cp >>> 12) & 0x3f),
        0x80 | ((cp >>> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
      i += 2;
    } else if (c < 0x80) {
      bytes.push(c);
      i++;
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      i++;
    } else {
      // Lone low surrogate or other non-ASCII BMP char – encode as 3-byte UTF-8
      bytes.push(
        0xe0 | (c >> 12),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
      i++;
    }
  }

  // Decode bytes as UTF-8
  let result = "";
  i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    let extra: number;

    if (b < 0x80) {
      cp = b;
      extra = 0;
    } else if (b >= 0xc0 && b < 0xe0) {
      cp = b & 0x1f;
      extra = 1;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = b & 0x0f;
      extra = 2;
    } else if (b >= 0xf0) {
      cp = b & 0x07;
      extra = 3;
    } else {
      // 0x80–0xBF: stray continuation byte
      return null;
    }

    if (i + extra >= bytes.length) return null;

    for (let j = 1; j <= extra; j++) {
      const cb = bytes[i + j];
      if (cb < 0x80 || cb > 0xbf) return null;
      cp = (cp << 6) | (cb & 0x3f);
    }

    // Reject overlong encodings, surrogates, and out-of-range code points
    if (extra === 1 && cp < 0x80) return null;
    if (extra === 2 && cp < 0x800) return null;
    if (extra === 3 && cp < 0x10000) return null;
    if (cp > 0x10ffff) return null;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;

    i += extra + 1;

    if (cp <= 0xffff) {
      result += String.fromCharCode(cp);
    } else {
      cp -= 0x10000;
      result += String.fromCharCode(
        0xd800 + (cp >> 10),
        0xdc00 + (cp & 0x3ff),
      );
    }
  }

  return result;
}

export function parseQuery(input: string): Query {
  let s = input;

  // Ignore one leading '?'
  if (s.length > 0 && s.charCodeAt(0) === 63) {
    s = s.slice(1);
  }

  // Ignore fragment
  const hashIdx = s.indexOf("#");
  if (hashIdx !== -1) {
    s = s.slice(0, hashIdx);
  }

  // Null-prototype object so __proto__, constructor, etc. are plain own keys
  const result = Object.create(null) as Query;

  if (s === "") return result;

  const pairs = s.split("&");

  for (const pair of pairs) {
    if (pair === "") continue;

    const eqIdx = pair.indexOf("=");
    let rawKey: string;
    let rawValue: string;

    if (eqIdx === -1) {
      rawKey = pair;
      rawValue = "";
    } else {
      rawKey = pair.slice(0, eqIdx);
      rawValue = pair.slice(eqIdx + 1);
    }

    // Replace '+' with space first
    const plusKey = rawKey.replace(/\+/g, " ");
    const plusValue = rawValue.replace(/\+/g, " ");

    // Percent-decode; fall back to the post-'+' string on failure
    const key = safePercentDecode(plusKey) ?? plusKey;
    const value = safePercentDecode(plusValue) ?? plusValue;

    // Skip empty keys
    if (key === "") continue;

    const existing = (result as Record<string, unknown>)[key];
    if (existing === undefined) {
      (result as Record<string, unknown>)[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      (result as Record<string, unknown>)[key] = [existing, value];
    }
  }

  return result;
}

function valueToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  throw new TypeError("Cannot convert value to string for query string");
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const element of value) {
        if (element === undefined || element === null) continue;
        const str = valueToString(element);
        pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(str));
      }
      continue;
    }

    const str = valueToString(value);
    pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(str));
  }

  return pairs.join("&");
}
