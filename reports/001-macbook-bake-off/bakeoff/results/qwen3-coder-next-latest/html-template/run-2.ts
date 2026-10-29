export class SafeHtml {
  private readonly value: string;
  private readonly isRaw: boolean;

  constructor(value: string, isRaw: boolean = false) {
    this.value = value;
    this.isRaw = isRaw;
  }

  toString(): string {
    return this.value;
  }

  // Private symbol for internal use to identify safe HTML instances
  static readonly #brand = Symbol("SafeHtml");
  [SafeHtml.#brand](): void {}
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
  const parts: string[] = [];
  
  for (let i = 0; i < strings.length; i++) {
    // Add the literal string part
    parts.push(strings[i]);

    // If there's a value after this string part, process it
    if (i < values.length) {
      const value = values[i];
      parts.push(renderValue(value));
    }
  }

  return new SafeHtml(parts.join(""), false);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup, true);
}

// Helper function to render a value according to the rules
function renderValue(value: unknown): string {
  // Handle SafeHtml instances (only those created by html or raw)
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // Handle null, undefined, true, false
  if (value == null || value === true || value === false) {
    return "";
  }

  // Handle arrays recursively
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item)).join("");
  }

  // Handle strings
  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Handle numbers and bigints
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  // For everything else (objects, functions, symbols, Dates), convert to string and escape
  return escapeHtml(String(value));
}
