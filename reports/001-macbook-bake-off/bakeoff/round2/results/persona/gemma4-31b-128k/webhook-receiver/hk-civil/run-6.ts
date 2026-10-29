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

  /**
   * Constant-time comparison to prevent timing attacks.
   */
  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Helper to format JSON responses.
   */
  function jsonResponse(status: number, body: object): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Expected format: t=123,v1=abc
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tValue = tPart.slice(2);
    const v1Value = v1Part.slice(3);

    // Validate that t consists of digits and v1 is 64 hex chars
    if (!/^\d+$/.test(tValue) || !/^[0-9a-f]{64}$/.test(v1Value)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const rawBodyBuffer = await req.arrayBuffer();
    const rawBodyUint8 = new Uint8Array(rawBodyBuffer);

    // Construct the payload: <t>.<raw body>
    const tBytes = encoder.encode(`${tValue}.`);
    const payload = new Uint8Array(tBytes.length + rawBodyUint8.length);
    payload.set(tBytes);
    payload.set(rawBodyUint8, tBytes.length);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      const computedSignature = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!timingSafeEqual(computedSignature, v1Value)) {
        return jsonResponse(401, { error: "invalid_signature" });
      }
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tValue, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(rawBodyUint8);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1Value)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Event handling
    try {
      await onEvent(parsedBody);
      // Mark as accepted only after successful execution
      acceptedSignatures.add(v1Value);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
