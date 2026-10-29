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
  const secretBytes = encoder.encode(secret);

  /**
   * Constant-time string comparison to prevent timing attacks.
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
   * Helper to create JSON responses.
   */
  function jsonResponse(status: number, body: { error: string }) {
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

    // 3. Signature validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Expecting "t=123,v1=hex64"
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
    const providedSignature = v1Part.slice(3);

    if (providedSignature.length !== 64) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const rawBody = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(rawBody);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // HMAC data: <t>.<raw body>
      const signedPayload = new Uint8Array(
        encoder.encode(tValue).length + 1 + bodyBytes.length,
      );
      const tBytes = encoder.encode(tValue);
      signedPayload.set(tBytes, 0);
      signedPayload[tBytes.length] = 46; // ASCII for '.'
      signedPayload.set(bodyBytes, tBytes.length + 1);

      const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        key,
        signedPayload,
      );

      const hashArray = new Uint8Array(signatureBuffer);
      const calculatedSignature = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!safeCompare(calculatedSignature, providedSignature)) {
        return jsonResponse(401, { error: "invalid_signature" });
      }
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check (± 300 seconds)
    const tSeconds = parseInt(tValue, 10);
    if (isNaN(tSeconds)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const currentTimeSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimeSeconds - tSeconds) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyString = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(bodyString);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay protection
    if (acceptedSignatures.has(providedSignature)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Call onEvent
    try {
      await onEvent(parsedBody);
      // Only mark as accepted if the handler responds 204
      acceptedSignatures.add(providedSignature);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
