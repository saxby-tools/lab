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
  const secretBytes = encoder.encode(secret);

  /**
   * Helper to create a JSON error response.
   */
  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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

    // 3. Signature validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header format: t=1767225600,v1=<signature>
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = match[1];
    const providedSig = match[2];

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    try {
      const tBytes = encoder.encode(tStr);
      const signedPayload = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
      signedPayload.set(tBytes);
      signedPayload[tBytes.length] = 46; // '.' character
      signedPayload.set(bodyBytes, tBytes.length + 1);

      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, signedPayload);
      const hashArray = Array.from(new Uint8Array(signatureBuffer));
      const computedSig = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      if (computedSig !== providedSig) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp validation
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (seenSignatures.has(providedSig)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Event handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only after successful handler execution
      seenSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
