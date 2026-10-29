export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const seenSignatures = new Set<string>();
  const now = options.now || (() => new Date());
  const encoder = new TextEncoder();

  // Pre-import the key to avoid repeated overhead, but keep the promise 
  // since the factory function itself is synchronous.
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const errorResponse = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return errorResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return errorResponse(405, "method_not_allowed");
    }

    // We need the raw body for both signature verification and JSON parsing.
    const bodyBytes = await req.arrayBuffer();

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return errorResponse(401, "invalid_signature");
    }

    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return errorResponse(401, "invalid_signature");
    }

    const [tPart, v1Part] = parts;
    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return errorResponse(401, "invalid_signature");
    }

    const tValue = tPart.slice(2);
    const providedSig = v1Part.slice(3);

    // Validate t is decimal digits and signature is 64 hex characters
    if (!/^\d+$/.test(tValue) || providedSig.length !== 64 || !/^[0-9a-f]+$/i.test(providedSig)) {
      return errorResponse(401, "invalid_signature");
    }

    try {
      const key = await keyPromise;
      const tBytes = encoder.encode(tValue + ".");
      const signedData = new Uint8Array(tBytes.length + bodyBytes.byteLength);
      signedData.set(tBytes);
      signedData.set(new Uint8Array(bodyBytes), tBytes.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, signedData);
      const signatureArray = Array.from(new Uint8Array(signatureBuffer));
      const computedSig = signatureArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (computedSig !== providedSig) {
        return errorResponse(401, "invalid_signature");
      }
    } catch {
      return errorResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tValue, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return errorResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (seenSignatures.has(providedSig)) {
      return errorResponse(409, "replayed");
    }

    // 7. Execute application handler
    try {
      await options.onEvent(event);
      // Delivery counts as accepted only upon successful completion of onEvent
      seenSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return errorResponse(500, "handler_failed");
    }
  };
}
