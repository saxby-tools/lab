export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

const PLUS_RE = /\+/g;

/**
 * Replace literal '+' with space, then percent-decode.
 * On a decode failure the post-replacement string is returned
 * unchanged so the caller never sees a thrown error.
 */
function decodeComponent(raw: string): string {
  const withSpaces = raw.replace(PLUS_RE, " ");

  try {
    return decodeURIComponent(withSpaces);
  } catch {
    return withSpaces;
  }
}

export function parseQuery(input: string): Query {
  let str = input;

  // Ignore a single leading '?'.
  if (str.startsWith("?")) {
    str = str.slice(1);
  }

  // Drop the fragment.
  const hash = str.indexOf("#");
  if (hash !== -1) {
    str = str.slice(0, hash);
  }

  // null prototype prevents __proto__, constructor, and
  // hasOwnProperty from triggering prototype setters.
  const result = Object.create(null) as Query;
  const seen = new Set<string>();

  for (const pair of str.split("&")) {
    if (pair === "") {
      continue;
    }

    // Split on the FIRST '=' only.
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);

    const key = decodeComponent(rawKey);
    const value = decodeComponent(rawVal);

    if (key === "") {
      continue;
    }

    if (seen.has(key)) {
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
      continue;
    }

    seen.add(key);
    result[key] = value;
  }

  return result;
}

// Coerce a scalar to its string form for serialization.
// Throws TypeError for objects, functions, symbols, etc.
function coerceValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  throw new TypeError(
    `Cannot encode value of type ${typeof value}`,
  );
}

function makePair(key: string, value: unknown): string {
  const enc = encodeURIComponent(key);
  const val = coerceValue(value);
  if (val === "") {
    return `${enc}=`;
  }
  return `${enc}=${val}`;
}

export function stringifyQuery(
  query: Record<string, unknown>,
): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    // null / undefined omit the key entirely.
    if (value === null) {
      continue;
    }
    if (value === undefined) {
      continue;
    }

    // Arrays emit one pair per element, skipping null/undefined.
    if (Array.isArray(value)) {
      for (const element of value) {
        if (element === null) {
          continue;
        }
        if (element === undefined) {
          continue;
        }
        pairs.push(makePair(key, element));
      }
      continue;
    }

    pairs.push(makePair(key, value));
  }

  return pairs.join("&");
}
