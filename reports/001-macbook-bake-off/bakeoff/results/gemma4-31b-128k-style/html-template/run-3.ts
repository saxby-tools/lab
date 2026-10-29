const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPE_MAP[char]);
}

export class SafeHtml {
  constructor(private readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

function stringifyValue(val: unknown): string {
  if (val === null) {
    return "";
  }

  if (val === undefined) {
    return "";
  }

  if (typeof val === "boolean") {
    return "";
  }

  if (val instanceof SafeHtml) {
    return val.toString();
  }

  if (typeof val === "number") {
    return String(val);
  }

  if (typeof val === "bigint") {
    return String(val);
  }

  if (Array.isArray(val)) {
    return val.map((item) => stringifyValue(item)).join("");
  }

  if (typeof val === "string") {
    return escapeHtml(val);
  }

  // Coerce complex types to string and then escape.
  return escapeHtml(String(val));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[],
): SafeHtml {
  let result = "";

  for (let i = 0; i < values.length; i++) {
    result += strings[i];
    result += stringifyValue(values[i]);
  }

  result += strings[strings.length - 1];

  return new SafeHtml(result);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
