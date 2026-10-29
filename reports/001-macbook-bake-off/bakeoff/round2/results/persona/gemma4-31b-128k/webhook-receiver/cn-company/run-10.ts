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
   * Helper to create JSON responses with the correct charset
   */
  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path validation
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method validation
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Header must be exactly "t=...,v1=..."
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tStr = tPart.slice(2);
    const v1Provided = v1Part.slice(3);

    // Validate t is numeric and v1 is 64 hex characters
    if (!/^\d+$/.test(tStr) || !/^[0-9a-f]{64}$/.test(v1Provided)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    let rawBody: Uint8Array;
    try {
      const buffer = await req.arrayBuffer();
      rawBody = new Uint8Array(buffer);
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Calculate HMAC-SHA256
    try {
      const keyData = encoder.encode(secret);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Payload: <t>.<raw body>
      const tBytes = encoder.encode(`${tStr}.`);
      const payload = new Uint8Array(tBytes.length + rawBody.length);
      payload.set(tBytes, 0);
      payload.set(rawBody, tBytes.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      const v1Calculated = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (v1Provided !== v1Calculated) {
        return jsonResponse(401, { error: "invalid_signature" });
      }
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness check
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validation
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(rawBody);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (seenSignatures.has(v1Provided)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Execute handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only after successful processing
      seenSignatures.add(v1Provided);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
