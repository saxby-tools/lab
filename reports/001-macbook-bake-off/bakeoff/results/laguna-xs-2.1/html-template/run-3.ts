class SafeHtml {
  private constructor(private readonly content: string) {}

  toString(): string {
    return this.content;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let result = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    result += renderValue(values[i]);
    const nextString = strings[i + 1] ?? "";
    result += nextString;
  }
  return new SafeHtml(result);
}

function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
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

export { SafeHtml, escapeHtml, html, raw };
