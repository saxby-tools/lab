export class SafeHtml {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/**
 * Internal helper to resolve a value to its HTML string representation
 * based on the specified safety and rendering rules.
 */
function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  if (value === null || value === undefined || typeof value === "boolean") {
    return "";
  }

  if (Array.isArray(value)) {
    let buffer = "";
    for (const item of value) {
      buffer += renderValue(item);
    }
    return buffer;
  }

  if (typeof value === "string") {
    return escapeHtml(value);
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  // Plain objects, functions, symbols, Dates, etc.
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[],
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
