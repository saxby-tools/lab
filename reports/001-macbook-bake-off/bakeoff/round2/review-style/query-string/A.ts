export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEADING_QUESTION = "?";
const HASH = "#";
const AMP = "&";
const EQ = "=";
const SPACE = " ";
const PLUS = "+";

// ---------------------------------------------------------------------------
// Helpers (ordered by call order)
// ---------------------------------------------------------------------------

function decodeComponent(raw: string): string {
  // + must be decoded to a space before percent-decoding so that
  // %2B (a literal +) is not confused with a space.
  const plusReplaced = raw.split(PLUS).join(SPACE);

  try {
    return decodeURIComponent(plusReplaced);
  } catch {
    // Invalid percent-encoding (e.g. %zz or truncated UTF-8):
    // keep the string exactly as it was after the + replacement.
    return plusReplaced;
  }
}

function coerceToString(value: unknown): string {
  // Only primitive scalars are serialisable; every other type
  // (object, function, symbol, …) is an error.
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return String(value);

  throw new TypeError(
    `Cannot stringify value of type ${typeof value}`,
  );
}

// ---------------------------------------------------------------------------
// parseQuery
// ---------------------------------------------------------------------------

export function parseQuery(input: string): Query {
  let str = input;

  if (str.startsWith(LEADING_QUESTION)) {
    str = str.slice(1);
  }

  const hashIdx = str.indexOf(HASH);
  if (hashIdx >= 0) {
    str = str.slice(0, hashIdx);
  }

  // null prototype so that __proto__, constructor, etc. become
  // ordinary own enumerable properties instead of triggering
  // the Object.prototype setter.
  const result = Object.create(null) as Query;
  const pairs = str.split(AMP);

  for (const pair of pairs) {
    if (pair === "") continue;

    // Split on the FIRST = only.
    const eqIdx = pair.indexOf(EQ);

    let rawKey: string;
    let rawValue: string;

    if (eqIdx < 0) {
      rawKey = pair;
      rawValue = "";
    } else {
      rawKey = pair.slice(0, eqIdx);
      rawValue = pair.slice(eqIdx + 1);
    }

    const key = decodeComponent(rawKey);
    const value = decodeComponent(rawValue);

    // Skip pieces whose decoded key is empty.
    if (key === "") continue;

    // First occurrence → string; subsequent → array in order.
    if (key in result) {
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

// ---------------------------------------------------------------------------
// stringifyQuery
// ---------------------------------------------------------------------------

export function stringifyQuery(
  query: Record<string, unknown>,
): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    // A value of undefined or null omits the key entirely.
    if (value === undefined) continue;
    if (value === null) continue;

    if (Array.isArray(value)) {
      // One key=value pair per element; skip undefined/null
      // elements; an empty array omits the key.
      for (const elem of value) {
        if (elem === undefined) continue;
        if (elem === null) continue;

        const encodedKey = encodeURIComponent(key);
        const encodedVal = encodeURIComponent(coerceToString(elem));
        pairs.push(`${encodedKey}=${encodedVal}`);
      }

      continue;
    }

    const encodedKey = encodeURIComponent(key);
    const encodedVal = encodeURIComponent(coerceToString(value));
    pairs.push(`${encodedKey}=${encodedVal}`);
  }

  return pairs.join(AMP);
}
