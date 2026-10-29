export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

/**
 * Creates a Deno request handler for receiving and validating signed webhooks.
 * 
 * This implementation ensures that webhooks are:
 * 1. Sent to the correct endpoint and via the correct method.
 * 2. Signed with a shared secret (HMAC-SHA256) and not tampered with.
 * 3. Recent (within a 5-minute window).
 * 4. Valid JSON.
 * 5. Not replayed (using a memory-based cache of accepted signatures).
 */
export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const acceptedSignatures = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Pre-import the HMAC key to avoid doing it on every single request.
  // We wrap this in a promise because importKey is asynchronous.
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

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

    // 3. Signature Header verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Header format: t=1234567890,v1=64charhex
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const [, tStr, v1] = match;

    // Read the raw body bytes once for signature and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    const key = await keyPromise;

    // Construct the string to sign: <t>.<raw body>
    const signedData = new Uint8Array(tStr.length + 1 + bodyBytes.length);
    signedData.set(encoder.encode(tStr), 0);
    signedData[tStr.length] = 46; // byte for '.'
    signedData.set(bodyBytes, tStr.length + 1);

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, signedData);
    const actualSignatureHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (actualSignatureHex !== v1) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check (± 300 seconds)
    const now = options.now ? options.now() : new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const tSeconds = parseInt(tStr, 10);

    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validation
    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay protection
    if (acceptedSignatures.has(v1)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Event execution
    try {
      await options.onEvent(event);
      // Mark as accepted only after successful onEvent execution
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch (err) {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
