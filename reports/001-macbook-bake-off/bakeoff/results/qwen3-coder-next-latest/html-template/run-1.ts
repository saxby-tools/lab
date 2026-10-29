export class SafeHtml {
  private readonly _chunks: Array<{ type: 'literal' | 'value'; content: string | SafeHtml }>;
  
  constructor(chunks: Array<{ type: 'literal' | 'value'; content: string | SafeHtml }>) {
    this._chunks = chunks;
  }
  
  toString(): string {
    let result = '';
    for (const chunk of this._chunks) {
      if (chunk.type === 'literal') {
        result += chunk.content;
      } else {
        const value = chunk.content;
        if (value instanceof SafeHtml) {
          result += value.toString();
        } else {
          result += value;
        }
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
  const chunks: Array<{ type: 'literal' | 'value'; content: string | SafeHtml }> = [];
  
  for (let i = 0; i < strings.length; i++) {
    // Add the literal string
    chunks.push({ type: 'literal', content: strings[i] });
    
    // If there's a value following this string, add it
    if (i < values.length) {
      const value = values[i];
      chunks.push({ 
        type: 'value', 
        content: renderValue(value) 
      });
    }
  }
  
  return new SafeHtml(chunks);
}

function renderValue(value: unknown): string | SafeHtml {
  if (value instanceof SafeHtml) {
    return value;
  }
  
  if (value == null || value === true || value === false) {
    return '';
  }
  
  if (Array.isArray(value)) {
    // Recursively process array elements
    const renderedElements: Array<string | SafeHtml> = [];
    for (const element of value) {
      renderedElements.push(renderValue(element));
    }
    
    // We need to combine them into a SafeHtml to avoid double escaping
    const chunks: Array<{ type: 'literal' | 'value'; content: string | SafeHtml }> = [];
    
    // Add empty string literal first
    chunks.push({ type: 'literal', content: '' });
    
    // Add each element as a value
    for (let i = 0; i < renderedElements.length; i++) {
      chunks.push({ 
        type: 'value', 
        content: renderedElements[i] 
      });
      // Add literal separator if not last element (but we don't add separator per requirements)
      if (i < renderedElements.length - 1) {
        chunks.push({ type: 'literal', content: '' });
      }
    }
    
    // Just flatten all values together with no separator
    return combineSafeHtmlChunks(chunks);
  }
  
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  
  // Everything else: convert to string and escape
  return escapeHtml(String(value));
}

// Helper to combine multiple chunks into a single SafeHtml, preserving the safety
function combineSafeHtmlChunks(chunks: Array<{ type: 'literal' | 'value'; content: string | SafeHtml }>): SafeHtml {
  return new SafeHtml(chunks);
}

export function raw(markup: string): SafeHtml {
  // Wrap the raw string in chunks structure that bypasses escaping
  const chunks: Array<{ type: 'literal' | 'value'; content: string | SafeHtml }> = [
    { type: 'value', content: markup }
  ];
  return new SafeHtml(chunks);
}
