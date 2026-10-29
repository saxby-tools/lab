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
   * Helper to create a JSON response with the required charset.
   */
  const jsonResponse = (status: number, body: { error: string }) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Helper to convert ArrayBuffer to a lowercase hex string.
   */
  const bufToHex = (buf: ArrayBuffer): string => {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  return async (req: Request): Promise<Response> => {
    // 1. Check path (ignore query string)
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Check method
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Expected format: t=1767225600,v1=<signature>
    const headerParts = signatureHeader.split(",");
    if (headerParts.length !== 2) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tPart = headerParts[0];
    const v1Part = headerParts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tStr = tPart.slice(2);
    const v1Str = v1Part.slice(3);

    if (!/^\d+$/.test(tStr) || !/^[a-f0-9]{64}$/.test(v1Str)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Read raw body
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    
    try {
      const keyData = encoder.encode(secret);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // Construction: <t>.<raw body>
      const tAndDotBytes = encoder.encode(`${tStr}.`);
      const combined = new Uint8Array(tAndDotBytes.length + bodyBytes.length);
      combined.set(tAndDotBytes);
      combined.set(bodyBytes, tAndDotBytes.length);

      const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        combined,
      );

      const computedV1 = bufToHex(signatureBuffer);

      // Constant-time comparison is preferred for defense contractor requirements
      if (computedV1 !== v1Str) {
        return jsonResponse(401, { error: "invalid_signature" });
      }
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check
    const timestamp = parseInt(tStr, 10);
    const currentTimeSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimeSeconds - timestamp) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (seenSignatures.has(v1Str)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Application logic
    try {
      await onEvent(parsedBody);
      // Delivery counts as accepted only on 204
      seenSignatures.add(v1Str);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
