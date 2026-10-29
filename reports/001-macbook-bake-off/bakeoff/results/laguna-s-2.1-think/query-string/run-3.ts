export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function decode(s: string): string {
  try {
    const decoded = decodeURIComponent(s);
    // Check for malformed UTF-8 by re-encoding
    if (encodeURIComponent(decoded) !== s) {
      throw new Error("malformed utf-8");
    }
    return decoded;
  } catch {
    return s;
  }
}

function parseValue(value: string): string {
  return decode(value.replace(/\+/g, " "));
}

export function parseQuery(input: string): Query {
  const query: Query = Object.create(null);

  if (input.startsWith("?")) {
    input = input.slice(1);
  }

  const hashIndex = input.indexOf("#");
  if (hashIndex !== -1) {
    input = input.slice(0, hashIndex);
  }

  const pairs = input.split("&").filter((p) => p !== "");

  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    let keyStr: string;
    let valueStr: string;

    if (eqIndex === -1) {
      keyStr = pair;
      valueStr = "";
    } else {
      keyStr = pair.slice(0, eqIndex);
      valueStr = pair.slice(eqIndex + 1);
    }

    const key = parseValue(keyStr);
    const value = parseValue(valueStr);

    if (key === "") {
      continue;
    }

    if (key in query) {
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

  // Convert to a normal object with own enumerable properties
  const result: Query = {};
  for (const key of Object.keys(query)) {
    Object.defineProperty(result, key, {
      value: query[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return result;
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const keys = Object.keys(query);
  const parts: string[] = [];

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
        const encodedValue = encode(encodeValue(item));
        parts.push(`${encode(key)}=${encodedValue}`);
      }
      continue;
    }

    const encodedValue = encode(encodeValue(value));
    parts.push(`${encode(key)}=${encodedValue}`);
  }

  return parts.join("&");
}

function encode(s: string): string {
  return encodeURIComponent(s);
}

function encodeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  } else {
    throw new TypeError("Invalid value for query string");
  }
}
