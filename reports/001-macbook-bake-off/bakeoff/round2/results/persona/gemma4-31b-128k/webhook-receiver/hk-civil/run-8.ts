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

  /**
   * Constant-time comparison of two strings to prevent timing attacks.
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
   * Helper to create a JSON response with the specified status and error.
   */
  function jsonResponse(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // 1. Path check
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    // 3. Signature validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Expected format: t=123,v1=abc...
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = tPart.slice(2);
    const v1Provided = v1Part.slice(3);

    if (tStr.length === 0 || v1Provided.length !== 64) {
      return jsonResponse(401, "invalid_signature");
    }

    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    
    // Construct the message: <t>.<raw body>
    const prefix = encoder.encode(`${tStr}.`);
    const data = new Uint8Array(prefix.length + bodyBytes.length);
    data.set(prefix);
    data.set(bodyBytes, prefix.length);

    try {
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", keyMaterial, data);
      const signatureArray = new Uint8Array(signatureBuffer);
      const v1Computed = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!safeCompare(v1Provided, v1Computed)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp validation
    const tSeconds = parseInt(tStr, 10);
    if (isNaN(tSeconds)) {
      return jsonResponse(401, "invalid_signature");
    }

    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validation
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (seenSignatures.has(v1Provided)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only after successful handler execution
      seenSignatures.add(v1Provided);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
