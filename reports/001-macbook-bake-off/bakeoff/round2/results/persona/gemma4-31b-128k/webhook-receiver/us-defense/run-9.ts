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

  // Pre-calculate secret key for performance
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);

  /**
   * Helper to create JSON responses with the required charset
   */
  const jsonResponse = (status: number, body: object) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Constant-time comparison to prevent timing attacks
   */
  const timingSafeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Format: t=123,v1=abc...
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
    const providedSig = v1Part.slice(3);

    // Validate t consists only of decimal digits and v1 is 64 hex chars
    if (!/^\d+$/.test(tValue) || !/^[0-9a-f]{64}$/.test(providedSig)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Get raw body for HMAC and JSON parsing
    const bodyBytes = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(bodyBytes);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Construct signed payload: <t>.<raw body>
      const tBytes = encoder.encode(tValue);
      const payload = new Uint8Array(tBytes.length + 1 + bodyUint8.length);
      payload.set(tBytes, 0);
      payload.set([46], tBytes.length); // dot character '.'
      payload.set(bodyUint8, tBytes.length + 1);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      
      // Convert buffer to hex string
      let calculatedSig = "";
      for (let i = 0; i < signatureArray.length; i++) {
        calculatedSig += signatureArray[i].toString(16).padStart(2, "0");
      }

      if (!timingSafeEqual(calculatedSig, providedSig)) {
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

    // 5. JSON parsing
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyUint8);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    // Note: The prompt defines the signature (v1) as the unique identifier for the delivery
    if (acceptedSignatures.has(providedSig)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Event Handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only on successful 204 response
      acceptedSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
