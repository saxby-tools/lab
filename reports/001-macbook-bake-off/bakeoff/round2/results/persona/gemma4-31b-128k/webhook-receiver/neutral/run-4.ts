export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

/**
 * Creates a Deno request handler for receiving and verifying signed webhooks.
 */
export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const seenSignatures = new Set<string>();
  const encoder = new TextEncoder();

  // Pre-import the key to avoid repeating the operation on every request
  // However, since we are in a factory function and the secret is a string, 
  // we will import the key inside the handler or cache it. 
  // To maintain the cleanest production-ready logic, we cache the CryptoKey.
  let cryptoKey: CryptoKey | null = null;

  async function getCryptoKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return cryptoKey;
  }

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    // 3. Signature presence and format
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, "invalid_signature");
    }

    const [, tStr, providedSig] = match;
    const tValue = parseInt(tStr, 10);

    // Read raw body for signature verification
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    
    // Construct the string to sign: <t>.<raw body>
    const prefix = encoder.encode(`${tStr}.`);
    const combined = new Uint8Array(prefix.length + bodyBytes.length);
    combined.set(prefix);
    combined.set(bodyBytes, prefix.length);

    try {
      const key = await getCryptoKey();
      const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
      const signatureArray = new Uint8Array(signatureBuffer);
      
      // Convert result to hex string
      const calculatedSig = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Constant-time comparison to prevent timing attacks
      if (!safeCompare(calculatedSig, providedSig)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp validation (±300 seconds)
    const currentUnixTime = Math.floor(now().getTime() / 1000);
    if (Math.abs(tValue - currentUnixTime) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validation
    let body: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      body = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (seenSignatures.has(providedSig)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application Event Handler
    try {
      await onEvent(body);
      // Mark as accepted only after successful execution
      seenSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}

/**
 * Constant-time string comparison to mitigate timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
