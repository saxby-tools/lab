// & must appear first so we never re-escape the ampersands in &lt;, &gt;, etc.

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPE_MAP[ch]);
}

// Only instances produced by html() or raw() are trusted.
// A private constructor prevents external `new SafeHtml(...)` at the type
// level, and instanceof guards the runtime path in renderValue.

export class SafeHtml {
  #markup: string;

  private constructor(markup: string) {
    this.#markup = markup;
  }

  static create(markup: string): SafeHtml {
    return new SafeHtml(markup);
  }

  toString(): string {
    return this.#markup;
  }
}

// Recursively render a single interpolated value.
// Order matters: SafeHtml must be checked before the generic fallback,
// and primitives before arrays/objects.

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // null, undefined, true, false all collapse to the empty string.

  if (value === null) {
    return '';
  }

  if (value === undefined) {
    return '';
  }

  if (value === true) {
    return '';
  }

  if (value === false) {
    return '';
  }

  if (typeof value === 'string') {
    return escapeHtml(value);
  }

  // Numbers and bigints contain only digits, sign, decimal point,
  // exponent marker, or 'n'—no HTML-special characters—so no
  // escaping is needed.

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  // Nested arrays are handled by recursing through map.
  // Join with '' so elements butt directly together.

  if (Array.isArray(value)) {
    return value.map(renderValue).join('');
  }

  // Objects, functions, symbols, Dates, and anything else:
  // stringify first, then escape so the output cannot inject markup.

  return escapeHtml(String(value));
}

// Interpolate values between the trusted literal segments of the template.
// Literal text is appended verbatim; only the values are rendered.

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[],
): SafeHtml {
  let result = '';

  for (let i = 0; i < strings.length; i++) {
    result += strings[i];

    if (i < values.length) {
      result += renderValue(values[i]);
    }
  }

  return SafeHtml.create(result);
}

// Wraps already-safe markup without any transformation.

export function raw(markup: string): SafeHtml {
  return SafeHtml.create(markup);
}
