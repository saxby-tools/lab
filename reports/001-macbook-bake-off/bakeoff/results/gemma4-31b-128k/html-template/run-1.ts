/**
 * SafeHtml represents a string that has already been escaped or is trusted 
 * as safe HTML markup.
 */
export class SafeHtml {
  constructor(private readonly value: string) {}

  /**
   * Returns the raw HTML string.
   */
  toString(): string {
    return this.value;
  }
}

/**
 * Escapes the five characters specified in the requirements to prevent XSS.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

/**
 * Internal helper to process interpolation values according to safety rules.
 */
function renderValue(value: unknown): string {
  // 1. A SafeHtml is inserted as is.
  if (value instanceof SafeHtml) {
    return value.toString();
  }

  // 2. null, undefined, true and false render as an empty string.
  if (value === null || value === undefined || typeof value === 'boolean') {
    return '';
  }

  // 3. A string is escaped with escapeHtml.
  if (typeof value === 'string') {
    return escapeHtml(value);
  }

  // 4. A number or bigint renders as String(value).
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  // 5. An array renders each element by these same rules recursively.
  if (Array.isArray(value)) {
    return value.map(renderValue).join('');
  }

  // 6. Anything else renders as String(value), escaped.
  // Note: String(value) is used instead of template literals to safely handle Symbols.
  return escapeHtml(String(value));
}

/**
 * Tagged template helper for building safe HTML.
 * Literal parts are trusted; interpolated values are escaped based on their type.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let result = strings[0];

  for (let i = 0; i < values.length; i++) {
    result += renderValue(values[i]) + strings[i + 1];
  }

  return new SafeHtml(result);
}

/**
 * Returns a SafeHtml object containing the markup unchanged.
 * Use this only for trusted content.
 */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
