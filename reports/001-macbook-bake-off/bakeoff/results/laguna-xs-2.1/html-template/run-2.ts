class SafeHtml {
  private constructor(private content: string) {}

  public static create(content: string): SafeHtml {
    return new SafeHtml(content);
  }

  public toString(): string {
    return this.content;
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
  if (value instanceof SafeHtml) {
    return value.toString();
  }
  if (value === null || value === undefined || typeof value === "boolean") {
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
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += renderValue(values[i]);
    }
  }
  return SafeHtml.create(result);
}

export function raw(markup: string): SafeHtml {
  return SafeHtml.create(markup);
}
