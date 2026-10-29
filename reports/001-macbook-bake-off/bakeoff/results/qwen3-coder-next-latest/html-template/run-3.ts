export class SafeHtml {
  private readonly chunks: Array<{ type: 'text', value: string } | { type: 'raw', value: string }>;

  constructor(chunks: Array<{ type: 'text', value: string } | { type: 'raw', value: string }>) {
    this.chunks = chunks;
  }

  toString(): string {
    let result = '';
    for (const chunk of this.chunks) {
      if (chunk.type === 'text') {
        result += escapeHtml(chunk.value);
      } else {
        result += chunk.value;
      }
    }
    return result;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  const chunks: Array<{ type: 'text', value: string } | { type: 'raw', value: string }> = [];
  
  for (let i = 0; i < strings.length; i++) {
    // Add the literal string part
    chunks.push({ type: 'text', value: strings[i] });
    
    // Process the interpolated value if there is one
    if (i < values.length) {
      const value = values[i];
      chunks.push(...processValue(value));
    }
  }
  
  return new SafeHtml(chunks);
}

function processValue(value: unknown): Array<{ type: 'text', value: string } | { type: 'raw', value: string }> {
  // Handle null, undefined, true, false
  if (value == null || value === true || value === false) {
    return [];
  }
  
  // Check if it's a SafeHtml instance
  if (value instanceof SafeHtml) {
    return value.chunks;
  }
  
  // Handle arrays
  if (Array.isArray(value)) {
    const chunks: Array<{ type: 'text', value: string } | { type: 'raw', value: string }> = [];
    for (const item of value) {
      chunks.push(...processValue(item));
    }
    return chunks;
  }
  
  // Handle strings
  if (typeof value === 'string') {
    return [{ type: 'text', value }];
  }
  
  // Handle numbers and bigints
  if (typeof value === 'number' || typeof value === 'bigint') {
    return [{ type: 'text', value: String(value) }];
  }
  
  // For everything else (objects, functions, symbols, Date, etc.),
  // convert to string and escape
  return [{ type: 'text', value: String(value) }];
}

export function raw(markup: string): SafeHtml {
  return new SafeHtml([{ type: 'raw', value: markup }]);
}
