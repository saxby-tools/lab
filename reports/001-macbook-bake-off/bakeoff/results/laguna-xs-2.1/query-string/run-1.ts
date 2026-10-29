export type QueryValue = string | string[];
export type Query = Record<string, QueryValue>;

export function parseQuery(input: string): Query {
    const decodeKeyOrValue = (s: string): string => {
        const replaced = s.replace(/\+/g, ' ');
        try {
            return decodeURIComponent(replaced);
        } catch {
            return replaced;
        }
    };

    let modified = input;

    // Remove leading '?'
    if (modified.startsWith('?')) {
        modified = modified.slice(1);
    }

    // Split out hash part
    const hashIndex = modified.indexOf('#');
    if (hashIndex !== -1) {
        modified = modified.slice(0, hashIndex);
    }

    const pieces = modified.split('&');
    const filteredPieces = pieces.filter(p => p.length > 0);

    const result: Query = Object.create(null);

    for (const piece of filteredPieces) {
        const eqIndex = piece.indexOf('=');

        let keyPart: string;
        let valuePart: string;

        if (eqIndex === -1) {
            keyPart = piece;
            valuePart = '';
        } else {
            keyPart = piece.slice(0, eqIndex);
            valuePart = piece.slice(eqIndex + 1);
        }

        const processedKey = decodeKeyOrValue(keyPart);
        if (processedKey === '') {
            continue;
        }

        const processedValue = decodeKeyOrValue(valuePart);

        const existing = result[processedKey];
        if (existing === undefined) {
            result[processedKey] = processedValue;
        } else {
            if (Array.isArray(existing)) {
                (existing as string[]).push(processedValue);
            } else {
                result[processedKey] = [existing, processedValue];
            }
        }
    }

    return result;
}

export function stringifyQuery(query: Record<string, unknown>): string {
    const parts: string[] = [];

    for (const key of Object.keys(query)) {
        const val = query[key];

        if (val === null || val === undefined) {
            continue;
        }

        let elements: unknown[];
        if (Array.isArray(val)) {
            elements = val;
        } else {
            elements = [val];
        }

        const keyEncoded = encodeURIComponent(key);

        for (const element of elements) {
            if (element === null || element === undefined) {
                continue;
            }

            let strElement: string;
            switch (typeof element) {
                case 'string':
                    strElement = element;
                    break;
                case 'number':
                case 'bigint':
                case 'boolean':
                    strElement = String(element);
                    break;
                default:
                    throw new TypeError(`Cannot stringify element of type ${typeof element}`);
            }

            const valueEncoded = encodeURIComponent(strElement);
            parts.push(`${keyEncoded}=${valueEncoded}`);
        }
    }

    return parts.join('&');
}
