export class SafeHtml {
  #content: string;

  private constructor(content: string) {
    this.#content = content;
  }

  toString(): string {
    return this.#content;
  }

  static create(content: string): SafeHtml {
    return new SafeHtml(content);
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

export function raw(markup: string): SafeHtml {
  return SafeHtml.create(markup);
}

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }
  if (value === null || value === undefined || value === true || value === false) {
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
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let content = strings[0];
  for (let i = 0; i < values.length; i++) {
    content += renderValue(values[i]) + strings[i + 1];
  }
  return SafeHtml.create(content);
}
