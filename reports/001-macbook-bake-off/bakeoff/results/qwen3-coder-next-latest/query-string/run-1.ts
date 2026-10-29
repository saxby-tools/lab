export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

function decodePlus(value: string): string {
  return value.replace(/\+/g, ' ');
}

function percentDecode(input: string): string {
  // Try to decode the input using decodeURIComponent
  try {
    return decodeURIComponent(input);
  } catch {
    // If decoding fails, return the input as is (after + replacement)
    return input;
  }
}

function safePercentDecode(input: string): string {
  // Replace '+' with spaces first, then try to percent-decode
  const replaced = decodePlus(input);
  return percentDecode(replaced);
}

function isSafeKeyChar(char: string): boolean {
  // Check for characters that should not be in keys for safety
  // We allow any printable ASCII except control chars, but reject control characters
  const code = char.charCodeAt(0);
  return code > 31 && code < 127;
}

function parseQuery(input: string): Query {
  // Remove leading '?' if present
  if (input.startsWith('?')) {
    input = input.slice(1);
  }
  
  // Remove fragment part if present
  const fragmentIndex = input.indexOf('#');
  if (fragmentIndex !== -1) {
    input = input.slice(0, fragmentIndex);
  }
  
  const result: Query = {};
  
  // Split on '&' and skip empty pieces
  const pairs = input.split('&').filter(piece => piece.length > 0);
  
  // Track keys in order of appearance
  const keysOrder: string[] = [];
  
  for (const pair of pairs) {
    // Split on the first '=' only
    const equalsIndex = pair.indexOf('=');
    let key: string;
    let value: string;
    
    if (equalsIndex === -1) {
      // No '=' found: key is the whole piece, value is empty string
      key = pair;
      value = '';
    } else {
      key = pair.slice(0, equalsIndex);
      value = pair.slice(equalsIndex + 1);
    }
    
    // Decode key and value: replace '+' first, then percent-decode
    let decodedKey = safePercentDecode(key);
    let decodedValue = safePercentDecode(value);
    
    // Skip keys whose decoded key is empty
    if (decodedKey.length === 0) {
      continue;
    }
    
    // Check for prototype pollution (optional, but good practice)
    // According to the problem statement, we should allow keys like '__proto__', etc.
    // so we'll just proceed without special handling
    
    // Add key to order list if not already present
    if (!result.hasOwnProperty(decodedKey)) {
      keysOrder.push(decodedKey);
      result[decodedKey] = decodedValue;
    } else {
      // If key already exists, handle the array case
      if (typeof result[decodedKey] === 'string') {
        // Convert to array with existing value
        result[decodedKey] = [result[decodedKey] as string, decodedValue];
      } else {
        // Already an array, push new value
        (result[decodedKey] as string[]).push(decodedValue);
      }
    }
  }
  
  // Ensure the result object is a plain object with keys in order of first appearance
  const orderedResult: Query = {};
  for (const key of keysOrder) {
    orderedResult[key] = result[key];
  }
  
  return orderedResult;
}

function isScalarValue(value: unknown): boolean {
  // Check if value is a valid scalar for stringification
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

function stringifyQuery(query: Record<string, unknown>): string {
  const result: string[] = [];
  
  // Iterate through keys in Object.keys order
  for (const key of Object.keys(query)) {
    const value = query[key];
    
    // Skip undefined and null values
    if (value === undefined || value === null) {
      continue;
    }
    
    // Handle arrays
    if (Array.isArray(value)) {
      // Process each element in the array
      for (const element of value) {
        if (element === undefined || element === null) {
          continue;
        }
        
        if (!isScalarValue(element)) {
          throw new TypeError(`Invalid query value for key "${key}": ${typeof element}`);
        }
        
        result.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(element))}`);
      }
    } else {
      // Handle scalar values
      if (!isScalarValue(value)) {
        throw new TypeError(`Invalid query value for key "${key}": ${typeof value}`);
      }
      
      result.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  
  return result.join('&');
}

export {
  parseQuery,
  stringifyQuery
};
