const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export class SafeHtml {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  if (value === null) {
    return "";
  }

  if (value === undefined) {
    return "";
  }

  if (typeof value === "boolean") {
    return "";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(renderValue).join("");
  }

  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Handle objects, symbols, dates, etc.
  return escapeHtml(String(value));
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
