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

  // Pre-compute the CryptoKey for the shared secret to avoid re-importing on every request
  const encoder = new TextEncoder();
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  /**
   * Helper to create a JSON response with the required content type.
   */
  const jsonResponse = (status: number, body: object) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Expected format: t=123,v1=abc (exactly two fields, no spaces)
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const timestampStr = tPart.slice(2);
    const providedSignature = v1Part.slice(3);

    // Validate that t is decimal digits and v1 is 64 hex chars
    if (!/^\d+$/.test(timestampStr) || !/^[a-f0-9]{64}$/.test(providedSignature)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Get raw body bytes for signature calculation
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    
    // Construction: <t>.<raw body>
    const signaturePayload = new Uint8Array(
      encoder.encode(timestampStr + "."),
      bodyBytes,
    );
    // We need a single combined buffer for the HMAC
    const combined = new Uint8Array(
      encoder.encode(timestampStr + ".").length + bodyBytes.length,
    );
    combined.set(encoder.encode(timestampStr + "."), 0);
    combined.set(bodyBytes, encoder.encode(timestampStr + ".").length);

    const key = await keyPromise;
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
    const actualSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (actualSignature !== providedSignature) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp validation
    const tSeconds = parseInt(timestampStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON body validation
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay prevention
    if (acceptedSignatures.has(providedSignature)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Application handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only upon successful 204 response
      acceptedSignatures.add(providedSignature);
      return new Response(null, { status: 204 });
    } catch (e) {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
