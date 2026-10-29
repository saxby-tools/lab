// A single regex pass avoids the classic double-escape bug
// that sequential .replace() calls would introduce.
const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const ESCAPE_RE = /[&<>"']/g;

// Only genuine instances may carry unescaped markup.
// Duck-typed objects are rejected by the instanceof check.
export class SafeHtml {
  readonly #markup: string;

  constructor(markup: string) {
    this.#markup = markup;
  }

  toString(): string {
    return this.#markup;
  }
}

//
//
export function escapeHtml(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPE[ch]);
}

//
//
function renderValue(value: unknown): string {
  // Trusted markup passes through untouched.
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // These four values carry no user-visible content.
  if (value === null) {
    return "";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return "";
  }

  // Strings are the primary injection vector.
  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Numeric types cannot produce markup characters.
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }

  // Arrays are flattened recursively so callers can
  // compose fragments without a manual join.
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item)).join("");
  }

  // Anything else (object, function, Symbol, Date, …)
  // is untrusted and must be escaped.
  return escapeHtml(String(value));
}

//
//
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  // Interleave literal segments with rendered values.
  // Literals are trusted; only values pass through
  // the safety pipeline.
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]);
    out += strings[i + 1];
  }
  return new SafeHtml(out);
}

//
//
export function raw(markup: string): SafeHtml {
  // Escalation point: the caller asserts this string
  // is already safe. Bypass all checks.
  return new SafeHtml(markup);
}
