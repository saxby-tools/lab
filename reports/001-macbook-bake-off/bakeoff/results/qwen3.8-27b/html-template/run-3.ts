// solution.ts

const BRAND = Symbol("SafeHtml.brand");

export class SafeHtml {
  private readonly _html: string;

  constructor(html: string, _brand: typeof BRAND) {
    this._html = html;
    void BRAND; // ensure the brand parameter is checked at compile time
  }

  toString(): string {
    return this._html;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderValue(value: unknown): string {
  // A SafeHtml instance is inserted as-is (no double-escaping).
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // null, undefined, true, false → empty string
  if (value === null || value === undefined || value === true || value === false) {
    return "";
  }

  // Arrays: render each element recursively, join with no separator.
  if (Array.isArray(value)) {
    let out = "";
    for (let i = 0; i < value.length; i++) {
      out += renderValue(value[i]);
    }
    return out;
  }

  // Numbers and bigints: String(value), no escaping needed
  // (they can only produce digits, '.', 'e', '+', '-', 'n', 'Infinity', 'NaN').
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  // Strings: escaped.
  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Everything else (plain objects, functions, symbols, Dates, etc.):
  // coerce with String() then escape. Duck-typed look-alikes of SafeHtml
  // are NOT trusted here — only instanceof catches above qualify.
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    result += renderValue(values[i]);
    result += strings[i + 1];
  }
  return new SafeHtml(result, BRAND);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup, BRAND);
}
