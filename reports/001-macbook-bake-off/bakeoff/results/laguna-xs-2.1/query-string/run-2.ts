type QueryValue = string | string[];

type Query = Record<string, QueryValue>;

export function parseQuery(input: string): Query {
  // Remove leading ?
  let str = input;
  if (str.startsWith('?')) {
    str = str.slice(1);
  }
  
  // Remove everything after #
  const hashIndex = str.indexOf('#');
  if (hashIndex !== -1) {
    str = str.slice(0, hashIndex);
  }
  
  // Create result object with null prototype to avoid prototype pollution
  const result: Query = Object.create(null);
  
  // Use a Map to preserve key order and track first appearance
  const keyOrder: string[] = [];
  
  const pieces = str.split('&');
  
  for (const piece of pieces) {
    // Skip empty pieces
    if (!piece) continue;
    
    // Split on first =
    let key: string;
    let value: string;
    const eqIndex = piece.indexOf('=');
    
    if (eqIndex === -1) {
      key = piece;
      value = '';
    } else {
      key = piece.slice(0, eqIndex);
      value = piece.slice(eqIndex + 1);
    }
    
    // Replace + with space
    const keyWithSpaces = key.replace(/\+/g, ' ');
    const valueWithSpaces = value.replace(/\+/g, ' ');
    
    // Try to percent-decode, if fails keep original
    let decodedKey: string;
    let decodedValue: string;
    
    try {
      decodedKey = decodeURIComponent(keyWithSpaces);
    } catch {
      decodedKey = keyWithSpaces;
    }
    
    try {
      decodedValue = decodeURIComponent(valueWithSpaces);
    } catch {
      decodedValue = valueWithSpaces;
    }
    
    // Skip if decoded key is empty
    if (decodedKey === '') continue;
    
    // Track key order and store values
    if (!(decodedKey in result)) {
      keyOrder.push(decodedKey);
    }
    
    if (Array.isArray(result[decodedKey])) {
      (result[decodedKey] as string[]).push(decodedValue);
    } else if (decodedKey in result) {
      result[decodedKey] = [result[decodedKey] as string, decodedValue];
    } else {
      result[decodedKey] = decodedValue;
    }
  }
  
  return result;
}

export function stringifyQuery(query: Record<string, unknown>): string {
  if (query === null || query === undefined) {
    return '';
  }
  
  const keys = Object.keys(query);
  const pairs: string[] = [];
  
  for (const key of keys) {
    const value = query[key];
    
    // Skip undefined or null
    if (value === undefined || value === null) {
      continue;
    }
    
    // Encode key
    const encodedKey = encodeURIComponent(key);
    
    if (Array.isArray(value)) {
      // Handle array values
      for (const element of value) {
        if (element === undefined || element === null) {
          continue;
        }
        
        let encodedValue: string;
        
        if (typeof element === 'string') {
          encodedValue = encodeURIComponent(element);
        } else if (typeof element === 'number' || typeof element === 'boolean' || typeof element === 'bigint') {
          encodedValue = encodeURIComponent(String(element));
        } else {
          throw new TypeError('Invalid value type in query string');
        }
        
        pairs.push(`${encodedKey}=${encodedValue}`);
      }
    } else if (typeof value === 'string') {
      const encodedValue = encodeURIComponent(value);
      pairs.push(`${encodedKey}=${encodedValue}`);
    } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      const encodedValue = encodeURIComponent(String(value));
      pairs.push(`${encodedKey}=${encodedValue}`);
    } else {
      throw new TypeError('Invalid value type in query string');
    }
  }
  
  return pairs.join('&');
}
