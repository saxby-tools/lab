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

  // Cache the CryptoKey promise to avoid repeated imports
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  /**
   * Constant-time comparison to prevent timing attacks on signatures.
   */
  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  function jsonResponse(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header format: t=123,v1=abc...
    const parts = sigHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tString = tPart.slice(2);
    const v1String = v1Part.slice(3);

    // Validate format: t is digits, v1 is 64 hex chars
    if (!/^\d+$/.test(tString) || !/^[0-9a-f]{64}$/.test(v1String)) {
      return jsonResponse(401, "invalid_signature");
    }

    const bodyBytes = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(bodyBytes);

    // Construct payload: <t>.<raw body>
    const tBytes = encoder.encode(tString);
    const payload = new Uint8Array(tBytes.length + 1 + bodyUint8.length);
    payload.set(tBytes, 0);
    payload.set([46], tBytes.length); // ASCII for '.'
    payload.set(bodyUint8, tBytes.length + 1);

    const cryptoKey = await keyPromise;
    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payload);
    const signatureArray = new Uint8Array(signatureBuffer);
    
    // Convert computed HMAC to lowercase hex string
    let computedHex = "";
    for (let i = 0; i < signatureArray.length; i++) {
      computedHex += signatureArray[i].toString(16).padStart(2, "0");
    }

    if (!timingSafeEqual(computedHex, v1String)) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tString, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyUint8);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1String)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application logic
    try {
      await onEvent(parsedBody);
    } catch (err) {
      return jsonResponse(500, "handler_failed");
    }

    // Mark as accepted only after successful response from onEvent
    acceptedSignatures.add(v1String);
    return new Response(null, { status: 204 });
  };
}
