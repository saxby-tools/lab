export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function decodeURIComponentWithFallback(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    // If decoding fails, return the input as-is
    return input;
  }
}

export function parseQuery(input: string): Query {
  // Remove leading '?' if present
  if (input.startsWith('?')) {
    input = input.slice(1);
  }
  
  // Remove fragment identifier and everything after '#'
  const hashIndex = input.indexOf('#');
  if (hashIndex !== -1) {
    input = input.slice(0, hashIndex);
  }
  
  // Split on '&'
  const pairs = input.split('&');
  
  const result: Query = {};
  const keyIndices = new Map<string, number>();
  
  for (const pair of pairs) {
    if (pair === '') {
      continue;
    }
    
    // Split on first '='
    const equalIndex = pair.indexOf('=');
    let key: string;
    let value: string;
    
    if (equalIndex === -1) {
      key = pair;
      value = '';
    } else {
      key = pair.slice(0, equalIndex);
      value = pair.slice(equalIndex + 1);
    }
    
    // Replace '+' with spaces
    key = key.replace(/\+/g, ' ');
    value = value.replace(/\+/g, ' ');
    
    // Try to percent-decode, but keep original if it fails
    key = decodeURIComponentWithFallback(key);
    value = decodeURIComponentWithFallback(value);
    
    // Skip if key is empty after decoding
    if (key === '') {
      continue;
    }
    
    // Handle multiple occurrences of the same key
    if (key in result) {
      if (typeof result[key] === 'string') {
        // Convert to array if it was a string
        result[key] = [result[key] as string];
      }
      // Push new value to array
      (result[key] as string[]).push(value);
    } else {
      // First occurrence - store as string
      result[key] = value;
      keyIndices.set(key, keyIndices.size);
    }
  }
  
  // Ensure keys maintain order of first appearance
  // Create ordered keys using the Map's order
  const orderedKeys = Array.from(keyIndices.keys());
  const orderedResult: Query = {};
  
  // Sort keys by their first appearance order
  for (const key of orderedKeys) {
    orderedResult[key] = result[key];
  }
  
  return orderedResult;
}

export function stringifyQuery(query: Record<string, unknown>): string {
  const pairs: string[] = [];
  
  // Get keys in Object.keys order
  const keys = Object.keys(query);
  
  for (const key of keys) {
    const value = query[key];
    
    // Skip undefined and null
    if (value === undefined || value === null) {
      continue;
    }
    
    if (Array.isArray(value)) {
      // Array values: one pair per element, skip undefined/null elements
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        
        // Convert to string
        const itemStr = String(item);
        // Encode key and value
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(itemStr)}`);
      }
    } else if (typeof value === 'string' || 
               typeof value === 'number' || 
               typeof value === 'boolean' || 
               typeof value === 'bigint') {
      // Convert to string for primitive types
      const valueStr = String(value);
      // Encode key and value
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(valueStr)}`);
    } else {
      // Throw TypeError for other types (objects, functions, symbols, etc.)
      throw new TypeError(`Invalid query value type: ${typeof value}`);
    }
  }
  
  return pairs.join('&');
}
