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
 * Internal helper to process values based on the defined rendering rules.
 */
function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean"
  ) {
    return "";
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

  if (typeof value === "string") {
    return escapeHtml(value);
  }

  // Handles objects, functions, symbols, Dates, etc.
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let result = "";

  for (let i = 0; i < strings.length; i++) {
    // Append the trusted literal part of the template
    result += strings[i];

    // Append the processed value, if one exists for this slot
    if (i < values.length) {
      result += renderValue(values[i]);
    }
  }

  return new SafeHtml(result);
}
