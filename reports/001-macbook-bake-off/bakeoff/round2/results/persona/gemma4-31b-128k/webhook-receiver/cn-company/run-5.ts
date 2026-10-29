export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const acceptedSignatures = new Set<string>();
  const encoder = new TextEncoder();
  const now = options.now || (() => new Date());

  // Pre-import the HMAC key to avoid doing it on every request
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  async function jsonResponse(status: number, body: object): Promise<Response> {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. The path is not /webhook
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. The method is not POST
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. The Webhook-Signature header is missing, malformed, or doesn't match
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Match header format exactly: t=123,v1=64hexchars
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const [, tValue, v1Value] = match;
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Calculate HMAC-SHA256 of "<t>.<raw body>"
    const tBytes = encoder.encode(tValue);
    const dotByte = encoder.encode(".");
    const payload = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    payload.set(tBytes);
    payload.set(dotByte, tBytes.length);
    payload.set(bodyBytes, tBytes.length + 1);

    const key = await keyPromise;
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
    const signatureArray = new Uint8Array(signatureBuffer);
    const calculatedSignature = Array.from(signatureArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedSignature !== v1Value) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. The timestamp is more than 300 seconds away from now()
    const tSeconds = parseInt(tValue, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. The body is not valid JSON
    let event: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. A delivery with the same signature was already accepted
    if (acceptedSignatures.has(v1Value)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Call onEvent and handle the result
    try {
      await options.onEvent(event);
      // Only mark as accepted if the response is 204
      acceptedSignatures.add(v1Value);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
