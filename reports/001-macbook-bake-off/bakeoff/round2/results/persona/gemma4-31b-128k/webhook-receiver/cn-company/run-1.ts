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
   * Helper to create a standard JSON error response
   */
  const jsonError = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonError(401, "invalid_signature");
    }

    const sigMatch = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!sigMatch) {
      return jsonError(401, "invalid_signature");
    }

    const [_, tStr, v1] = sigMatch;
    const bodyBytes = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(bodyBytes);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Construct data: <t>.<raw body>
      const tBytes = encoder.encode(tStr);
      const combined = new Uint8Array(tBytes.length + 1 + bodyUint8.length);
      combined.set(tBytes);
      combined.set([46], tBytes.length); // '.' character
      combined.set(bodyUint8, tBytes.length + 1);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
      const signatureHex = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (signatureHex !== v1) {
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
      const decodedBody = new TextDecoder().decode(bodyUint8);
      parsedBody = JSON.parse(decodedBody);
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1)) {
      return jsonError(409, "replayed");
    }

    // 7. Application logic
    try {
      await onEvent(parsedBody);
      // Mark as accepted only if onEvent succeeds and we respond with 204
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch {
      return jsonError(500, "handler_failed");
    }
  };
}
