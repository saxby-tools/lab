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
   * Helper to create JSON error responses
   */
  const errorResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    // 1. The path is not /webhook
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return errorResponse(404, "not_found");
    }

    // 2. The method is not POST
    if (req.method !== "POST") {
      return errorResponse(405, "method_not_allowed");
    }

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return errorResponse(401, "invalid_signature");
    }

    // Expected format: t=1767225600,v1=64hexchars
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return errorResponse(401, "invalid_signature");
    }

    const [, tStr, v1] = match;
    const rawBody = new Uint8Array(await req.arrayBuffer());

    try {
      const keyData = encoder.encode(secret);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Signature is HMAC of "<t>.<raw body>"
      const prefix = encoder.encode(`${tStr}.`);
      const payload = new Uint8Array(prefix.length + rawBody.length);
      payload.set(prefix);
      payload.set(rawBody, prefix.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payload);
      const signatureHex = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (signatureHex !== v1) {
        return errorResponse(401, "invalid_signature");
      }
    } catch {
      return errorResponse(401, "invalid_signature");
    }

    // 4. Timestamp validation
    const nowSeconds = Math.floor(now().getTime() / 1000);
    const tSeconds = parseInt(tStr, 10);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return errorResponse(401, "stale_timestamp");
    }

    // 5. Valid JSON body
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(rawBody);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (acceptedSignatures.has(v1)) {
      return errorResponse(409, "replayed");
    }

    // 7. Event handling
    try {
      await onEvent(parsedBody);
      // Only mark as accepted if onEvent succeeds and we are about to return 204
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch {
      return errorResponse(500, "handler_failed");
    }
  };
}
