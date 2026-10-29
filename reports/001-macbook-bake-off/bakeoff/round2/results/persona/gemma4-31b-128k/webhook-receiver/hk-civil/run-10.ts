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
   * Helper to create standardized JSON error responses.
   */
  const jsonError = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Constant-time string comparison to prevent timing attacks.
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
      return jsonError(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return jsonError(401, "invalid_signature");
    }

    const sigMatch = sigHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!sigMatch) {
      return jsonError(401, "invalid_signature");
    }

    const [, tStr, providedSig] = sigMatch;
    const t = parseInt(tStr, 10);

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonError(401, "invalid_signature");
    }

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const prefix = encoder.encode(`${tStr}.`);
      const payload = new Uint8Array(prefix.length + bodyBytes.length);
      payload.set(prefix);
      payload.set(bodyBytes, prefix.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      const computedSig = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!safeCompare(computedSig, providedSig)) {
        return jsonError(401, "invalid_signature");
      }
    } catch {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp check
    // |now() - t| <= 300 seconds
    const currentTimeSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimeSeconds - t) > 300) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(providedSig)) {
      return jsonError(409, "replayed");
    }

    // 7. Event handler execution
    try {
      await onEvent(parsedBody);
      // Mark as accepted only upon successful response
      acceptedSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonError(500, "handler_failed");
    }
  };
}
