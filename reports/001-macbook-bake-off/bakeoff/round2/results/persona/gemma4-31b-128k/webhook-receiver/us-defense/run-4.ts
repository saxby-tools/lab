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
   * Helper to construct JSON error responses.
   */
  function jsonError(status: number, error: string) {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

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

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonError(401, "invalid_signature");
    }

    const headerMatch = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!headerMatch) {
      return jsonError(401, "invalid_signature");
    }

    const [, tStr, providedSig] = headerMatch;
    const rawBodyBytes = new Uint8Array(await req.arrayBuffer());

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Payload is <t>.<raw body>
      const tPrefixBytes = encoder.encode(`${tStr}.`);
      const payload = new Uint8Array(tPrefixBytes.length + rawBodyBytes.length);
      payload.set(tPrefixBytes);
      payload.set(rawBodyBytes, tPrefixBytes.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const computedSig = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!safeCompare(computedSig, providedSig)) {
        return jsonError(401, "invalid_signature");
      }
    } catch {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(rawBodyBytes);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (seenSignatures.has(providedSig)) {
      return jsonError(409, "replayed");
    }

    // 7. Event Handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only upon successful response
      seenSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonError(500, "handler_failed");
    }
  };
}
