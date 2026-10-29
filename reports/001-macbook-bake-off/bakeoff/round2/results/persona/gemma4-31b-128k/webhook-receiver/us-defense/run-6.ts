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
  const decoder = new TextDecoder();

  const jsonResponse = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

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

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
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

    // Header format: t=1767225600,v1=<signature>
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, "invalid_signature");
    }

    const tString = match[1];
    const v1Provided = match[2];

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // Create the signing payload: <t>.<raw body>
    const prefix = encoder.encode(`${tString}.`);
    const payload = new Uint8Array(prefix.length + bodyBytes.length);
    payload.set(prefix);
    payload.set(bodyBytes, prefix.length);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      
      // Convert signature bytes to lowercase hex string
      const v1Computed = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!timingSafeEqual(v1Computed, v1Provided)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check (± 300 seconds)
    const tSeconds = parseInt(tString, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validation
    let parsedBody: unknown;
    try {
      const bodyText = decoder.decode(bodyBytes);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (acceptedSignatures.has(v1Provided)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only on success
      acceptedSignatures.add(v1Provided);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
