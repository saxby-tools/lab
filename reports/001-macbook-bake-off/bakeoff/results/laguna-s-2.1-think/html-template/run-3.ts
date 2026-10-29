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
  let result = "";
  for (const ch of text) {
    switch (ch) {
      case "&":
        result += "&amp;";
        break;
      case "<":
        result += "&lt;";
        break;
      case ">":
        result += "&gt;";
        break;
      case '"':
        result += "&quot;";
        break;
      case "'":
        result += "&#39;";
        break;
      default:
        result += ch;
    }
  }
  return result;
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
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
    let result = "";
    for (const item of value) {
      result += renderValue(item);
    }
    return result;
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
  return new SafeHtml(result);
}
