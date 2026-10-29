// Constants ---------------------------------------------------------------

const LEADING_Q: string = "?";
const FRAGMENT: string = "#";
const AMP: string = "&";
const EQ: string = "=";
const PLUS: string = "+";
const SPACE: string = " ";

// Types -------------------------------------------------------------------

export type QueryValue = string | string[];
export type Query = Record<string, QueryValue>;

// safeDecode — called by parseQuery ---------------------------------------

function safeDecode(raw: string): string {
  // '+' means space in form-urlencoded data; substitute it before
  // percent-decoding so that a literal '+' encoded as '%2B' survives.
  const afterPlus = raw.split(PLUS).join(SPACE);

  try {
    return decodeURIComponent(afterPlus);
  } catch {
    // Malformed percent-sequence — keep the post-'+' string verbatim.
    return afterPlus;
  }
}

// parseQuery --------------------------------------------------------------

export function parseQuery(input: string): Query {
  // Accept both a bare query ("a=1") and one with a leading '?'.
  let str = input;
  if (str[0] === LEADING_Q) {
    str = str.slice(1);
  }

  // Everything from '#' onward is a fragment, not part of the query.
  const hashIdx = str.indexOf(FRAGMENT);
  if (hashIdx !== -1) {
    str = str.slice(0, hashIdx);
  }

  // A null-prototype object keeps __proto__, constructor, hasOwnProperty,
  // etc. as ordinary own properties without mutating Object.prototype.
  const result = Object.create(null) as Query;

  const segments = str.split(AMP);

  for (const seg of segments) {
    // "&&" and a trailing "&" yield empty segments.
    if (seg === "") {
      continue;
    }

    // Split on the FIRST '=' only: "a=b=c" → key "a", value "b=c".
    const eqIdx = seg.indexOf(EQ);
    const rawKey = eqIdx === -1 ? seg : seg.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? "" : seg.slice(eqIdx + 1);

    const key = safeDecode(rawKey);

    // A key that decodes to "" is meaningless.
    if (key === "") {
      continue;
    }

    const val = safeDecode(rawVal);

    // First occurrence stores a bare string; later ones build an array.
    if (!(key in result)) {
      result[key] = val;
      continue;
    }

    const prev = result[key];

    if (!Array.isArray(prev)) {
      result[key] = [prev, val];
      continue;
    }

    prev.push(val);
  }

  return result;
}

// encodeScalar — called by stringifyQuery ---------------------------------

function encodeScalar(val: unknown): string {
  if (typeof val === "string") {
    return encodeURIComponent(val);
  }

  // number, boolean, and bigint all stringify the same way.
  if (typeof val === "number") {
    return encodeURIComponent(String(val));
  }

  if (typeof val === "boolean") {
    return encodeURIComponent(String(val));
  }

  if (typeof val === "bigint") {
    return encodeURIComponent(String(val));
  }

  // Objects, functions, symbols, nested arrays, … are not encodable.
  throw new TypeError(
    `Cannot stringify value of type ${typeof val}`,
  );
}

// stringifyQuery ----------------------------------------------------------

export function stringifyQuery(
  query: Record<string, unknown>,
): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const val = query[key];

    // undefined / null → omit the key entirely.
    if (val === undefined) {
      continue;
    }
    if (val === null) {
      continue;
    }

    const encKey = encodeURIComponent(key);

    // Scalar: emit a single pair.
    if (!Array.isArray(val)) {
      pairs.push(`${encKey}=${encodeScalar(val)}`);
      continue;
    }

    // Array: one pair per element; skip undefined / null elements.
    // An empty (or all-skipped) array produces no pairs.
    for (const elem of val) {
      if (elem === undefined) {
        continue;
      }
      if (elem === null) {
        continue;
      }
      pairs.push(`${encKey}=${encodeScalar(elem)}`);
    }
  }

  return pairs.join(AMP);
}
