export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const acceptedSignatures = new Set<string>();
  const encoder = new TextEncoder();

  // Pre-import the HMAC key to avoid repeating the operation for every request
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  /**
   * Constant-time comparison to prevent timing attacks on the signature.
   */
  function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Converts an ArrayBuffer to a lowercase hex string.
   */
  function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Helper to construct standard error responses.
   */
  function errorResponse(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return errorResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return errorResponse(405, "method_not_allowed");
    }

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return errorResponse(401, "invalid_signature");
    }

    // Header must be: t=123,v1=abc (exactly these two, in order, no spaces)
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return errorResponse(401, "invalid_signature");
    }

    const [, tStr, v1] = match;
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Create signing payload: <t>.<raw body>
    const tPrefixBytes = encoder.encode(`${tStr}.`);
    const payload = new Uint8Array(tPrefixBytes.length + bodyBytes.length);
    payload.set(tPrefixBytes);
    payload.set(bodyBytes, tPrefixBytes.length);

    const key = await keyPromise;
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
    const computedV1 = bufToHex(signatureBuffer);

    if (!safeCompare(computedV1, v1)) {
      return errorResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return errorResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1)) {
      return errorResponse(409, "replayed");
    }

    // 7. Application handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only after onEvent succeeds
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch (e) {
      return errorResponse(500, "handler_failed");
    }
  };
}
