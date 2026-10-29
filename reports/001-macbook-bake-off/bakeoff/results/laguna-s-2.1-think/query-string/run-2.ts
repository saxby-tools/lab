export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseQuery(input: string): Query {
  const query: Query = Object.create(null);

  const hashIndex = input.indexOf("#");
  if (hashIndex !== -1) {
    input = input.slice(0, hashIndex);
  }

  if (input[0] === "?") {
    input = input.slice(1);
  }

  const parts = input.split("&");

  for (const part of parts) {
    if (part === "") {
      continue;
    }

    let key: string;
    let value: string;

    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) {
      key = part;
      value = "";
    } else {
      key = part.slice(0, eqIndex);
      value = part.slice(eqIndex + 1);
    }

    key = key.replace(/\+/g, " ");
    value = value.replace(/\+/g, " ");

    const decodedKey = safeDecodeURIComponent(key);
    const decodedValue = safeDecodeURIComponent(value);

    if (decodedKey === "") {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(query, decodedKey)) {
      const existing = query[decodedKey];
      if (Array.isArray(existing)) {
        existing.push(decodedValue);
      } else {
        query[decodedKey] = [existing, decodedValue];
      }
    } else {
      query[decodedKey] = decodedValue;
    }
  }

  return query;
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }

      for (const element of value) {
        if (element === undefined || element === null) {
          continue;
        }

        if (typeof element !== "string" && typeof element !== "number" &&
            typeof element !== "boolean" && typeof element !== "bigint") {
          throw new TypeError(`Unsupported value in array for key "${key}"`);
        }

        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(element))}`);
      }
    } else {
      if (typeof value !== "string" && typeof value !== "number" &&
          typeof value !== "boolean" && typeof value !== "bigint") {
        throw new TypeError(`Unsupported value for key "${key}"`);
      }

      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }

  return pairs.join("&");
}
