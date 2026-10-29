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
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Helper to create a JSON response with the correct content type.
   */
  function jsonResponse(status: number, error: string) {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tString = tPart.slice(2);
    const providedSignature = v1Part.slice(3);

    // Verify signature hex length
    if (providedSignature.length !== 64) {
      return jsonResponse(401, "invalid_signature");
    }

    const bodyBytes = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(bodyBytes);

    try {
      const keyData = encoder.encode(secret);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Payload is <t>.<raw body>
      const tBytes = encoder.encode(tString);
      const payload = new Uint8Array(tBytes.length + 1 + bodyUint8.length);
      payload.set(tBytes);
      payload.set([46], tBytes.length); // ASCII for '.'
      payload.set(bodyUint8, tBytes.length + 1);

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      const computedSignature = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!timingSafeEqual(computedSignature, providedSignature)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tString, 10);
    if (isNaN(tSeconds)) {
      return jsonResponse(401, "invalid_signature");
    }
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let eventBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyUint8);
      eventBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(providedSignature)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Execute handler
    try {
      await onEvent(eventBody);
      // Mark as accepted only after onEvent succeeds
      acceptedSignatures.add(providedSignature);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
