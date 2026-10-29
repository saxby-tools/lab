export class SafeHtml {
  #value: string;

  constructor(markup: string) {
    this.#value = markup;
  }

  toString(): string {
    return this.#value;
  }
}

export function escapeHtml(text: string): string {
  const replacements: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  return text.replace(/[&<>"']/g, (char) => replacements[char]);
}

export function html(
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

export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) {
    return value.toString();
  } else if (value === null || value === undefined || typeof value === 'boolean') {
    return '';
  } else if (typeof value === 'string') {
    return escapeHtml(value);
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  } else if (Array.isArray(value)) {
    return value.map(renderValue).join('');
  } else {
    return escapeHtml(String(value));
  }
}
