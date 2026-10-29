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
   * Helper to create a JSON response with the specific required charset.
   */
  const jsonResponse = (status: number, error: string): Response => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Constant-time comparison of two strings to prevent timing attacks.
   */
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

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header must be exactly: t=123,v1=abc...
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tValue = tPart.slice(2);
    const v1Value = v1Part.slice(3);

    // Basic validation of the values
    if (!/^\d+$/.test(tValue) || !/^[0-9a-f]{64}$/.test(v1Value)) {
      return jsonResponse(401, "invalid_signature");
    }

    // We need the raw body for signature verification
    const rawBody = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(rawBody);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signedPayload = encoder.encode(`${tValue}.${new TextDecoder().decode(bodyUint8)}`);
      // Note: The prompt specifies <t>.<raw body>. Since <raw body> are bytes, 
      // we concatenate the UTF-8 bytes of t + "." + raw bytes of body.
      const payloadBytes = new Uint8Array(
        encoder.encode(`${tValue}.`).length + bodyUint8.length,
      );
      payloadBytes.set(encoder.encode(`${tValue}.`), 0);
      payloadBytes.set(bodyUint8, encoder.encode(`${tValue}.`).length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payloadBytes);
      const signatureArray = new Uint8Array(signatureBuffer);
      const calculatedHex = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!safeCompare(calculatedHex, v1Value)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const timestamp = parseInt(tValue, 10);
    const currentTimestamp = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimestamp - timestamp) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyUint8);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1Value)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application Logic
    try {
      await onEvent(parsedBody);
      // Mark as accepted only upon successful response
      acceptedSignatures.add(v1Value);
      return new Response(null, { status: 204 });
    } catch (err) {
      return jsonResponse(500, "handler_failed");
    }
  };
}
