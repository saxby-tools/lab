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
   * Constant-time string comparison to prevent timing attacks.
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
   * Converts an ArrayBuffer to a lowercase hex string.
   */
  function bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Standard JSON error response.
   */
  function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Signature extraction and validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonError(401, "invalid_signature");
    }

    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonError(401, "invalid_signature");
    }

    const tPart = parts[0];
    const vPart = parts[1];

    if (!tPart.startsWith("t=") || !vPart.startsWith("v1=")) {
      return jsonError(401, "invalid_signature");
    }

    const tValue = tPart.slice(2);
    const providedSignature = vPart.slice(3);

    // Validation for signature format (64 hex chars) and timestamp format (digits)
    if (providedSignature.length !== 64 || !/^\d+$/.test(tValue)) {
      return jsonError(401, "invalid_signature");
    }

    const bodyBytes = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(bodyBytes);

    // HMAC-SHA256 Calculation: HMAC(secret, t + "." + body)
    try {
      const keyData = encoder.encode(secret);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const tBytes = encoder.encode(tValue);
      const message = new Uint8Array(tBytes.length + 1 + bodyUint8.length);
      message.set(tBytes, 0);
      message[tBytes.length] = 46; // ASCII for '.'
      message.set(bodyUint8, tBytes.length + 1);

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, message);
      const computedSignature = bufferToHex(signatureBuffer);

      if (!timingSafeEqual(computedSignature, providedSignature)) {
        return jsonError(401, "invalid_signature");
      }
    } catch {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp drift check (± 300 seconds)
    const tSeconds = parseInt(tValue, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let payload: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyUint8);
      payload = JSON.parse(bodyText);
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(providedSignature)) {
      return jsonError(409, "replayed");
    }

    // 7. Event handler execution
    try {
      await onEvent(payload);
      // A delivery counts as accepted only when the handler responds 204
      acceptedSignatures.add(providedSignature);
      return new Response(null, { status: 204 });
    } catch {
      return jsonError(500, "handler_failed");
    }
  };
}
