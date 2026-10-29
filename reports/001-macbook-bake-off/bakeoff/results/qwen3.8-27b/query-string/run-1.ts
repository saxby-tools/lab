export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

// ── helpers ──────────────────────────────────────────────────────────

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

function tryPercentDecode(input: string): string {
  // `input` has already had '+' replaced with ' '.
  // Attempt full percent-decode with strict UTF-8 validation.
  // On any failure return `input` unchanged.
  const out: string[] = [];
  let buf: number[] = [];

  const flush = (): boolean => {
    if (buf.length === 0) return true;
    try {
      out.push(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buf)));
    } catch {
      return false;
    }
    buf = [];
    return true;
  };

  let i = 0;
  while (i < input.length) {
    if (input[i] === "%") {
      if (i + 2 >= input.length) return input;
      const h1 = hexVal(input.charCodeAt(i + 1));
      const h2 = hexVal(input.charCodeAt(i + 2));
      if (h1 === -1 || h2 === -1) return input;
      buf.push((h1 << 4) | h2);
      i += 3;
    } else {
      if (!flush()) return input;
      out.push(input[i]);
      i++;
    }
  }

  if (!flush()) return input;
  return out.join("");
}

// ── parseQuery ───────────────────────────────────────────────────────

export function parseQuery(input: string): Query {
  // Strip one leading '?'
  if (input.charCodeAt(0) === 63 /* ? */) {
    input = input.slice(1);
  }

  // Strip fragment
  const hash = input.indexOf("#");
  if (hash !== -1) {
    input = input.slice(0, hash);
  }

  // null-prototype object prevents __proto__ / constructor pollution
  const result = Object.create(null) as Query;
  const seen = new Set<string>();

  const pairs = input.split("&");

  for (const pair of pairs) {
    if (pair === "") continue;

    // Split on the FIRST '='
    const eq = pair.indexOf("=");
    let rawKey: string;
    let rawVal: string;
    if (eq === -1) {
      rawKey = pair;
      rawVal = "";
    } else {
      rawKey = pair.slice(0, eq);
      rawVal = pair.slice(eq + 1);
    }

    // '+' → space first, then percent-decode
    const key = tryPercentDecode(rawKey.replace(/\+/g, " "));
    const val = tryPercentDecode(rawVal.replace(/\+/g, " "));

    // Skip empty keys
    if (key === "") continue;

    // Accumulate: single → string, repeated → string[]
    if (seen.has(key)) {
      const prev = (result as Record<string, QueryValue>)[key];
      if (Array.isArray(prev)) {
        prev.push(val);
      } else {
        (result as Record<string, QueryValue>)[key] = [prev as string, val];
      }
    } else {
      seen.add(key);
      (result as Record<string, QueryValue>)[key] = val;
    }
  }

  return result;
}

// ── stringifyQuery ───────────────────────────────────────────────────

function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  throw new TypeError("Cannot serialize value of type " + typeof value);
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];

  for (const key of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[key];

    // null / undefined → omit
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const element of value) {
        if (element === undefined || element === null) continue;
        const encoded = encodeURIComponent(coerceToString(element));
        pairs.push(encodeURIComponent(key) + "=" + encoded);
      }
      // empty array or all-skipped → nothing pushed → key omitted
    } else {
      const str = coerceToString(value);
      pairs.push(encodeURIComponent(key) + "=" + encodeURIComponent(str));
    }
  }

  return pairs.join("&");
}
