export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

const PLUS_REGEX = /\+/g;

function decodeValue(val: string): string {
  const replaced = val.replace(PLUS_REGEX, " ");

  try {
    return decodeURIComponent(replaced);
  } catch {
    return replaced;
  }
}

export function parseQuery(input: string): Query {
  const result = Object.create(null);

  let remaining = input;

  if (remaining.startsWith("?")) {
    remaining = remaining.slice(1);
  }

  const hashIndex = remaining.indexOf("#");

  if (hashIndex !== -1) {
    remaining = remaining.slice(0, hashIndex);
  }

  const pieces = remaining.split("&");

  for (const piece of pieces) {
    if (piece === "") {
      continue;
    }

    const eqIndex = piece.indexOf("=");
    let rawKey: string;
    let rawValue: string;

    if (eqIndex === -1) {
      rawKey = piece;
      rawValue = "";
    } else {
      rawKey = piece.slice(0, eqIndex);
      rawValue = piece.slice(eqIndex + 1);
    }

    const key = decodeValue(rawKey);

    if (key === "") {
      continue;
    }

    const value = decodeValue(rawValue);

    const existing = result[key];

    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }

  return result;
}

function encodeValue(val: unknown): string {
  if (typeof val === "string") {
    return encodeURIComponent(val);
  }

  if (typeof val === "number") {
    return encodeURIComponent(String(val));
  }

  if (typeof val === "boolean") {
    return encodeURIComponent(String(val));
  }

  if (typeof val === "bigint") {
    return encodeURIComponent(String(val));
  }

  throw new TypeError("Unsupported query value type");
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  const keys = Object.keys(query);

  for (const key of keys) {
    const value = query[key];

    if (value === null) {
      continue;
    }

    if (value === undefined) {
      continue;
    }

    const encodedKey = encodeURIComponent(key);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null) {
          continue;
        }

        if (item === undefined) {
          continue;
        }

        const encodedVal = encodeValue(item);
        pairs.push(`${encodedKey}=${encodedVal}`);
      }
    } else {
      const encodedVal = encodeValue(value);
      pairs.push(`${encodedKey}=${encodedVal}`);
    }
  }

  return pairs.join("&");
}
