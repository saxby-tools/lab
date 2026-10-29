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

function render(value: unknown): string {
  // Only genuine SafeHtml instances (created by html/raw) are trusted.
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // Falsy-ish values render as nothing.
  if (value === null || value === undefined || value === true || value === false) {
    return "";
  }

  // Strings are escaped.
  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Numbers and bigints are safe without escaping (only digits, sign, 'e', 'n').
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  // Arrays are rendered element-by-element, joined with no separator.
  if (Array.isArray(value)) {
    let out = "";
    for (let i = 0; i < value.length; i++) {
      out += render(value[i]);
    }
    return out;
  }

  // Everything else (plain objects, functions, symbols, Date, …) is
  // stringified and then escaped. Duck-typed "safe-looking" objects land here
  // because the instanceof check above already excluded them.
  return escapeHtml(String(value));
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
