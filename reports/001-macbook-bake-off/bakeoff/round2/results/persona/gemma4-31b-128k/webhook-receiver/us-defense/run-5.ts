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

  // Pre-import the HMAC key for performance
  // Since we are in a closure, this is computed once per handler instance
  const keyPromise = crypto.subtle
    .importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

  /**
   * Performs a constant-time string comparison to prevent timing attacks.
   */
  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  function jsonResponse(status: number, error: string) {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

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

    // 3. Signature Header parsing and validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header format: t=1767225600,v1=<signature>
    const headerMatch = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!headerMatch) {
      return jsonResponse(401, "invalid_signature");
    }

    const [, tStr, v1] = headerMatch;

    // To verify the signature, we need the raw body bytes
    const rawBody = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(rawBody);

    // Construct the payload for signing: <t>.<raw body>
    const tBytes = encoder.encode(`${tStr}.`);
    const payload = new Uint8Array(tBytes.length + bodyBytes.length);
    payload.set(tBytes);
    payload.set(bodyBytes, tBytes.length);

    try {
      const key = await keyPromise;
      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      
      // Convert buffer to lowercase hex string
      const computedV1 = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!timingSafeEqual(computedV1, v1)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const providedT = parseInt(tStr, 10);
    const currentT = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentT - providedT) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(text);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application handler execution
    try {
      await onEvent(event);
      // Delivery is only "accepted" if onEvent succeeds
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
