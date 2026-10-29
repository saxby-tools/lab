export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const nowFn = options.now || (() => new Date());
  const seenSignatures = new Set<string>();

  // Pre-import the key to avoid doing it on every single request.
  // We wrap it in a promise because importKey is async.
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  /**
   * Helper to generate JSON responses with the correct charset.
   */
  const jsonResponse = (data: unknown, status: number) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Helper to convert an ArrayBuffer to a lowercase hex string.
   */
  const bufToHex = (buf: ArrayBuffer) => {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse({ error: "not_found" }, 404);
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    // 3. Signature validation
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }

    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }

    const tValue = tPart.slice(2);
    const v1Value = v1Part.slice(3);

    // Read raw body for signature verification and later JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    const tBytes = encoder.encode(tValue + ".");
    const payload = new Uint8Array(tBytes.length + bodyBytes.length);
    payload.set(tBytes);
    payload.set(bodyBytes, tBytes.length);

    const key = await keyPromise;
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
    const calculatedSignature = bufToHex(signatureBuffer);

    if (calculatedSignature !== v1Value) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }

    // 4. Timestamp window check
    const tSeconds = parseInt(tValue, 10);
    if (isNaN(tSeconds)) {
      return jsonResponse({ error: "invalid_signature" }, 401);
    }

    const nowSeconds = Math.floor(nowFn().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse({ error: "stale_timestamp" }, 401);
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    // 6. Replay protection
    if (seenSignatures.has(v1Value)) {
      return jsonResponse({ error: "replayed" }, 409);
    }

    // 7. Execute onEvent
    try {
      await options.onEvent(parsedBody);
      // Mark as accepted only on success
      seenSignatures.add(v1Value);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse({ error: "handler_failed" }, 500);
    }
  };
}
