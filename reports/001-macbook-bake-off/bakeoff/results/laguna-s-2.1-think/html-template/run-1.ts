export class SafeHtml {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  toString(): string {
    return this.#value;
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
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += renderValue(values[i]);
    }
  }
  return new SafeHtml(result);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean") {
    return "";
  }
  if (value instanceof SafeHtml) {
    return value.toString();
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
  return escapeHtml(String(value));
}
