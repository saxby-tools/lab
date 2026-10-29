export class SafeHtml {
  #markup: string;

  constructor(markup: string) {
    this.#markup = markup;
  }

  toString(): string {
    return this.#markup;
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

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]);
    out += strings[i + 1];
  }
  return new SafeHtml(out);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function render(value: unknown): string {
  // Safe instances are inserted verbatim (no double-escaping on nesting).
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // null, undefined, true, false → empty string
  if (
    value === null ||
    value === undefined ||
    value === true ||
    value === false
  ) {
    return "";
  }

  // Strings are escaped.
  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Numbers and bigints render via String() without escaping.
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  // Arrays: each element rendered recursively, joined with no separator.
  if (Array.isArray(value)) {
    let out = "";
    for (const item of value) {
      out += render(item);
    }
    return out;
  }

  // Everything else (object, function, symbol, Date, …) is untrusted:
  // stringify then escape.  A look-alike that merely has a toString
  // property is NOT a SafeHtml instance, so it falls through here.
  return escapeHtml(String(value));
}
