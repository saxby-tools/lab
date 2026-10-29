export type QueryValue = string | string[];
export type Query = Record<string, QueryValue>;

/**
 * Decode a percent-encoded string, replacing + with space first
 * Returns the decoded string or the original string if decoding fails
 */
function decodeComponent(str: string): string {
  // Replace + with space first
  let decoded = str.replace(/\+/g, ' ');
  
  try {
    // Try to decode the whole string at once
    decoded = decodeURIComponent(decoded);
  } catch (e) {
    // If decoding fails (e.g., malformed percent encoding), keep original
    // (This includes cut-off UTF-8 sequences)
    decoded = str.replace(/\+/g, ' ');
  }
  
  return decoded;
}

/**
 * Parse a query string into a key-value object
 */
export function parseQuery(input: string): Query {
  // Remove leading ? if present
  if (input.startsWith('?')) {
    input = input.substring(1);
  }
  
  // Remove fragment part (# and everything after)
  const fragmentIndex = input.indexOf('#');
  if (fragmentIndex !== -1) {
    input = input.substring(0, fragmentIndex);
  }
  
  const result: Query = {};
  const keysOrder: string[] = [];
  
  // Split on & and skip empty pieces
  const pairs = input.split('&').filter(piece => piece.length > 0);
  
  for (const pair of pairs) {
    // Split on first = only
    const eqIndex = pair.indexOf('=');
    let key: string;
    let value: string;
    
    if (eqIndex === -1) {
      // No = means empty value
      key = pair;
      value = '';
    } else {
      key = pair.substring(0, eqIndex);
      value = pair.substring(eqIndex + 1);
    }
    
    // Decode key and value
    const decodedKey = decodeComponent(key);
    const decodedValue = decodeComponent(value);
    
    // Skip keys that decode to empty string
    if (decodedKey === '') continue;
    
    // Record keys in order of first appearance
    if (!result.hasOwnProperty(decodedKey)) {
      keysOrder.push(decodedKey);
    }
    
    // Handle multiple values for same key
    if (result[decodedKey] === undefined) {
      // First occurrence - store as string
      result[decodedKey] = decodedValue;
    } else if (typeof result[decodedKey] === 'string') {
      // Second occurrence - convert to array
      result[decodedKey] = [result[decodedKey] as string, decodedValue];
    } else {
      // Additional occurrences - push to array
      (result[decodedKey] as string[]).push(decodedValue);
    }
  }
  
  // Return result with proper prototype (no prototype manipulation)
  // Since we used Object and didn't use prototype chain features,
  // the result is already safe from prototype pollution
  return result;
}

/**
 * Serialize a query object into a query string
 */
export function stringifyQuery(query: Record<string, unknown>): string {
  const parts: string[] = [];
  
  // Get keys in Object.keys order
  const keys = Object.keys(query);
  
  for (const key of keys) {
    const value = query[key];
    
    // Skip undefined and null values
    if (value === undefined || value === null) {
      continue;
    }
    
    // Handle arrays
    if (Array.isArray(value)) {
      for (const item of value) {
        // Skip undefined/null elements in arrays
        if (item === undefined || item === null) {
          continue;
        }
        
        // Convert item to string and validate type
        const itemStr = convertToString(item, 'array element');
        
        // Encode and add to parts
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(itemStr)}`);
      }
      // Skip key if array is empty or all elements were skipped
      if (value.length === 0 || !value.some(v => v !== undefined && v !== null)) {
        continue;
      }
    } else {
      // Convert single value to string and validate type
      const valueStr = convertToString(value, 'value');
      
      // Encode and add to parts
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(valueStr)}`);
    }
  }
  
  return parts.join('&');
}

/**
 * Convert a value to string according to the rules
 * Throws TypeError for unsupported types
 */
function convertToString(value: unknown, context: string): string {
  if (typeof value === 'string') {
    return value;
  } else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  } else {
    throw new TypeError(`Unsupported value type for ${context}: ${typeof value}`);
  }
}
