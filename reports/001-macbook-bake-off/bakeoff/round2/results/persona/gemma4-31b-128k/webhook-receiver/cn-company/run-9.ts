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

  return async (req: Request): Promise<Response> => {
    const jsonResponse = (status: number, error: string) => {
      return new Response(JSON.stringify({ error }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    };

    // 1. Path check
    const url = new URL(req.url, "http://localhost");
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

    const sigMatch = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!sigMatch) {
      return jsonResponse(401, "invalid_signature");
    }

    const [, tStr, v1] = sigMatch;
    const t = parseInt(tStr, 10);

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const signedPayload = encoder.encode(`${tStr}.`);
      const combined = new Uint8Array(signedPayload.length + bodyBytes.length);
      combined.set(signedPayload);
      combined.set(bodyBytes, signedPayload.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
      const signatureArray = Array.from(new Uint8Array(signatureBuffer));
      const calculatedV1 = signatureArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (calculatedV1 !== v1) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const currentTimeSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimeSeconds - t) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Execute handler
    try {
      await onEvent(event);
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
