class SafeHtmlImpl {
  #content: string;

  constructor(content: string) {
    this.#content = content;
  }

  toString(): string {
    return this.#content;
  }
}

export class SafeHtml extends SafeHtmlImpl {
  // Private branding constructor is inherited from SafeHtmlImpl.
  // Only this module can create instances because the constructor is not exposed publicly.
}

// Module-private brand set to ensure only real SafeHtmlImpl instances are recognized.
const safeHtmlBrand = Symbol("safeHtmlBrand");
(SafeHtmlImpl.prototype as any)[safeHtmlBrand] = true;

function isSafeHtml(value: unknown): value is SafeHtml {
  return (
    value instanceof SafeHtmlImpl &&
    (value as any)[safeHtmlBrand] === true
  );
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
  if (isSafeHtml(value)) {
    return value.toString();
  }

  if (value == null || value === true || value === false) {
    return "";
  }

  if (typeof value === "string") {
    return escapeHtml(value);
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(renderValue).join("");
  }

  // Everything else (objects, functions, symbols, Dates, etc.) is escaped.
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  const parts: string[] = [];
  for (let i = 0; i < strings.length; i++) {
    parts.push(strings[i]);
    if (i < values.length) {
      parts.push(renderValue(values[i]));
    }
  }
  return new SafeHtml(parts.join(""));
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
