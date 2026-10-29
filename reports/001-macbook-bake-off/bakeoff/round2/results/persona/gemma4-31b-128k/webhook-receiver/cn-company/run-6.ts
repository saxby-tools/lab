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

  // Pre-import the secret as a CryptoKey for performance
  // Note: Since importKey is async, we handle the key inside the handler 
  // or wrap the handler logic to ensure the key is available.
  // To keep the export signature exactly as requested, we initialize 
  // the key on the first request or use a promise.
  let keyPromise: Promise<CryptoKey> | null = null;

  const getKey = async () => {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return keyPromise;
  };

  const jsonResponse = (status: number, body: object) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    try {
      // 1. Path check
      const url = new URL(req.url);
      if (url.pathname !== "/webhook") {
        return jsonResponse(404, { error: "not_found" });
      }

      // 2. Method check
      if (req.method !== "POST") {
        return jsonResponse(405, { error: "method_not_allowed" });
      }

      // 3. Signature presence, format, and validity
      const signatureHeader = req.headers.get("Webhook-Signature");
      if (!signatureHeader) {
        return jsonResponse(401, { error: "invalid_signature" });
      }

      // Regex for strict format: t=...,v1=... (64 hex chars)
      const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
      if (!match) {
        return jsonResponse(401, { error: "invalid_signature" });
      }

      const [, tStr, v1] = match;
      const bodyBuffer = await req.arrayBuffer();
      const bodyBytes = new Uint8Array(bodyBuffer);

      // Construct <t>.<raw body>
      const tBytes = encoder.encode(`${tStr}.`);
      const combined = new Uint8Array(tBytes.length + bodyBytes.length);
      combined.set(tBytes);
      combined.set(bodyBytes, tBytes.length);

      const key = await getKey();
      const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
      const signatureArray = new Uint8Array(signatureBuffer);
      
      // Convert signature to lowercase hex string
      const computedV1 = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (computedV1 !== v1) {
        return jsonResponse(401, { error: "invalid_signature" });
      }

      // 4. Timestamp check (+/- 300 seconds)
      const tSeconds = parseInt(tStr, 10);
      const nowSeconds = Math.floor(now().getTime() / 1000);
      if (Math.abs(nowSeconds - tSeconds) > 300) {
        return jsonResponse(401, { error: "stale_timestamp" });
      }

      // 5. JSON validity
      let parsedBody: unknown;
      try {
        const text = new TextDecoder().decode(bodyBytes);
        parsedBody = JSON.parse(text);
      } catch {
        return jsonResponse(400, { error: "invalid_json" });
      }

      // 6. Replay check
      if (acceptedSignatures.has(v1)) {
        return jsonResponse(409, { error: "replayed" });
      }

      // 7. Event Handler
      try {
        await onEvent(parsedBody);
      } catch (e) {
        return jsonResponse(500, { error: "handler_failed" });
      }

      // Mark as accepted only on success
      acceptedSignatures.add(v1);
      return new Response(null, { status: 204 });
    } catch (err) {
      // Generic catch-all for unexpected errors during request processing
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
