export class SafeHtml {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
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

function renderValue(val: unknown): string {
  if (val instanceof SafeHtml) {
    return val.toString();
  }

  if (val === null) {
    return "";
  }

  if (val === undefined) {
    return "";
  }

  if (val === true) {
    return "";
  }

  if (val === false) {
    return "";
  }

  if (Array.isArray(val)) {
    return val
      .map((item) => renderValue(item))
      .join("");
  }

  if (typeof val === "string") {
    return escapeHtml(val);
  }

  if (typeof val === "number") {
    return String(val);
  }

  if (typeof val === "bigint") {
    return String(val);
  }

  // Catch-all for objects, symbols, functions, etc.
  return escapeHtml(String(val));
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
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
