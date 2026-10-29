export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function safeDecode(raw: string): string {
  // Replace + with space first
  const replaced = raw.replace(/\+/g, " ");
  // Then percent-decode; on failure return the post-+ string unchanged
  try {
    return decodeURIComponent(replaced);
  } catch {
    return replaced;
  }
}

export function parseQuery(input: string): Query {
  // Ignore one leading '?'
  let str = input;
  if (str.startsWith("?")) {
    str = str.slice(1);
  }

  // Ignore '#' and everything after it
  const hashIdx = str.indexOf("#");
  if (hashIdx !== -1) {
    str = str.slice(0, hashIdx);
  }

  // Split on '&' and skip empty pieces
  const pairs = str.split("&").filter((piece) => piece.length > 0);

  // Use a Map to preserve first-appearance order and collect duplicates
  const entries = new Map<string, string[]>();

  for (const pair of pairs) {
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

    const key = safeDecode(rawKey);
    if (key === "") continue;

    const value = safeDecode(rawValue);

    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.push(value);
    } else {
      entries.set(key, [value]);
    }
  }

  // Build result with null prototype to prevent __proto__ pollution
  const result: Query = Object.create(null) as Query;

  for (const [key, values] of entries) {
    result[key] = values.length === 1 ? values[0] : values;
  }

  return result;
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") {
    return encodeURIComponent(value);
  }
  if (typeof value === "number") {
    return encodeURIComponent(String(value));
  }
  if (typeof value === "boolean") {
    return encodeURIComponent(String(value));
  }
  if (typeof value === "bigint") {
    return encodeURIComponent(String(value));
  }
  throw new TypeError(
    `Cannot serialize value of type ${typeof value}`,
  );
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = query[key];

    // Top-level undefined or null omits the key
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      // Each element produces one key=value pair; skip undefined/null elements
      for (const element of value) {
        if (element === undefined || element === null) continue;
        pairs.push(`${encodeURIComponent(key)}=${serializeValue(element)}`);
      }
    } else {
      pairs.push(`${encodeURIComponent(key)}=${serializeValue(value)}`);
    }
  }

  return pairs.join("&");
}
