export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const seenSignatures = new Set<string>();
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

    // 3. Signature header check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const [tPart, v1Part] = parts;
    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = tPart.slice(2);
    const v1Hex = v1Part.slice(3);

    // Validate hex signature length and content
    if (v1Hex.length !== 64 || !/^[0-9a-f]+$/.test(v1Hex)) {
      return jsonResponse(401, "invalid_signature");
    }

    // Validate timestamp format
    if (!/^\d+$/.test(tStr)) {
      return jsonResponse(401, "invalid_signature");
    }

    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(options.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      const payload = new Uint8Array(tStr.length + 1 + bodyBytes.length);
      payload.set(encoder.encode(tStr), 0);
      payload.set([46], tStr.length); // 46 is '.'
      payload.set(bodyBytes, tStr.length + 1);

      const sigBytes = new Uint8Array(32);
      for (let i = 0; i < 64; i += 2) {
        sigBytes[i / 2] = parseInt(v1Hex.substring(i, i + 2), 16);
      }

      const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, payload);
      if (!isValid) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp staleness check
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor((options.now?.() || new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (seenSignatures.has(v1Hex)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application handler execution
    try {
      await options.onEvent(body);
      seenSignatures.add(v1Hex);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
