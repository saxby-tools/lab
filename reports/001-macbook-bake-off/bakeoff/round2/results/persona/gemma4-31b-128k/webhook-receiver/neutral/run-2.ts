export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const seenSignatures = new Set<string>();
  const encoder = new TextEncoder();

  // Pre-import the key to optimize subsequent requests
  // We wrap the crypto logic in the handler to ensure it stays within the Deno environment
  const getCryptoKey = async () => {
    return await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  };

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const safeCompare = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
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

    // Need the raw body for signature verification
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Format: t=1767225600,v1=<signature>
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, "invalid_signature");
    }

    const [, tStr, providedSig] = match;
    const key = await getCryptoKey();
    
    // The payload is <t>.<raw body>
    const tBytes = encoder.encode(`${tStr}.`);
    const combined = new Uint8Array(tBytes.length + bodyBytes.length);
    combined.set(tBytes);
    combined.set(bodyBytes, tBytes.length);

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
    const actualSig = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (!safeCompare(providedSig, actualSig)) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (seenSignatures.has(providedSig)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application handler
    try {
      await onEvent(parsedBody);
    } catch {
      return jsonResponse(500, "handler_failed");
    }

    // Mark as accepted and return success
    seenSignatures.add(providedSig);
    return new Response(null, { status: 204 });
  };
}
