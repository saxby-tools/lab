class SafeHtml {
  #html: string;

  constructor(html: string) {
    this.#html = html;
  }

  toString(): string {
    return this.#html;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += renderValue(values[i]);
    }
  }
  return new SafeHtml(result);
}

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  }
  if (value === null || value === undefined || value === true || value === false) {
    return '';
  }
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(renderValue).join('');
  }
  return escapeHtml(String(value));
}

function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

export { SafeHtml, escapeHtml, html, raw };
