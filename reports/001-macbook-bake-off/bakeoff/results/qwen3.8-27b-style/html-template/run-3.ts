// The five characters that can break out of HTML text or attribute context.
// & is listed so the entities we emit are never re-escaped in a second pass.
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

export class SafeHtml {
  private readonly _markup: string;

  constructor(markup: string) {
    this._markup = markup;
  }

  toString(): string {
    return this._markup;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// Render a single interpolated value into its HTML fragment.
//
// Order matters: SafeHtml and nullish/boolean are checked before the
// type-of switches so that a SafeHtml is never accidentally stringified
// and a boolean is never treated as a string.
function renderValue(value: unknown): string {
  // Only instances produced by `html` or `raw` are trusted.
  // An object that mimics the shape (own toString, a _markup property,
  // etc.) must still be escaped.
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean') {
    return '';
  }

  if (typeof value === 'string') {
    return escapeHtml(value);
  }

  // Numbers and bigints can only contain 0-9, +/-, n — all safe.
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(renderValue).join('');
  }

  // Fallback: plain objects, functions, symbols, Dates, …
  // String(value) may return markup-like text, so escape it.
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  // Literal segments are trusted; only the interpolated values are
  // rendered, so user data can never inject markup.
  let out = strings[0];

  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]);
    out += strings[i + 1];
  }

  return new SafeHtml(out);
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
