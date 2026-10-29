export type QueryValue = string | string[];

export type Query = Record<string, QueryValue>;

export function parseQuery(input: string): Query {
    input = input.replace(/^\?/, '');
    let hashIndex = input.indexOf('#');
    if (hashIndex !== -1) {
        input = input.slice(0, hashIndex);
    }

    const parts = input.split('&').filter((p) => p.length > 0);
    const result: Query = Object.create(null);

    function tryDecode(s: string): string {
        const replaced = s.replace(/\+/g, ' ');
        try {
            return decodeURIComponent(replaced);
        } catch {
            return replaced;
        }
    }

    for (const part of parts) {
        let key = part;
        let value = '';

        const eqIndex = part.indexOf('=');
        if (eqIndex === -1) {
            key = part;
        } else {
            key = part.slice(0, eqIndex);
            value = part.slice(eqIndex + 1);
        }

        const decodedKey = tryDecode(key);
        if (decodedKey === '') {
            continue;
        }

        const decodedVal = tryDecode(value);
        const existingVal = result[decodedKey];

        if (existingVal === undefined) {
            result[decodedKey] = decodedVal;
        } else if (Array.isArray(existingVal)) {
            existingVal.push(decodedVal);
        } else {
            result[decodedKey] = [existingVal, decodedVal];
        }
    }

    return result;
}

export function stringifyQuery(query: Record<string, unknown>): string {
    const result: string[] = [];

    function processValue(value: unknown): string {
        if (typeof value === 'string') {
            return value;
        } else if (
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            typeof value === 'bigint'
        ) {
            return String(value);
        } else if (typeof value === 'symbol') {
            throw new TypeError('Value cannot be a symbol');
        } else {
            throw new TypeError('Invalid value type');
        }
    }

    for (const key of Object.keys(query)) {
        const value = query[key];
        if (value === null || value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const element of value) {
                if (element === null || element === undefined) {
                    continue;
                }
                try {
                    const processed = processValue(element);
                    const encodedKey = encodeURIComponent(key);
                    const encodedVal = encodeURIComponent(processed);
                    result.push(`${encodedKey}=${encodedVal}`);
                } catch {
                    throw new TypeError('Invalid element inside array');
                }
            }
        } else {
            try {
                const processed = processValue(value);
                const encodedKey = encodeURIComponent(key);
                const encodedVal = encodeURIComponent(processed);
                result.push(`${encodedKey}=${encodedVal}`);
            } catch {
                throw new TypeError('Invalid value type');
            }
        }
    }

    return result.join('&');
}
