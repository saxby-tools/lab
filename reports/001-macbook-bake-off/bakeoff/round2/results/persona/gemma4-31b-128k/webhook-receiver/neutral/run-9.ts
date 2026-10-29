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

  // Pre-import the key to optimize performance
  const secretBytes = encoder.encode(secret);
  const keyPromise = crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const timingSafeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  };

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

    const parts = sigHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = tPart.slice(2);
    const v1Provided = v1Part.slice(3);

    // Body bytes are required for both signature and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    
    try {
      const key = await keyPromise;
      const signedPayload = encoder.encode(`${tStr}.${new TextDecoder().decode(bodyBytes)}`);
      // The prompt requires the raw body bytes. Since TextDecoder might mangle 
      // binary data, we must construct the buffer correctly.
      const tBytes = encoder.encode(`${tStr}.`);
      const data = new Uint8Array(tBytes.length + bodyBytes.length);
      data.set(tBytes);
      data.set(bodyBytes, tBytes.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, data);
      const signatureArray = Array.from(new Uint8Array(signatureBuffer));
      const v1Computed = signatureArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (!timingSafeEqual(v1Provided, v1Computed)) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tTimestamp = parseInt(tStr, 10);
    if (isNaN(tTimestamp)) {
      return jsonResponse(401, "invalid_signature");
    }

    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(tTimestamp - nowSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON check
    let eventBody: unknown;
    try {
      eventBody = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1Provided)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Event Execution
    try {
      await onEvent(eventBody);
      // Mark as accepted only upon successful response
      acceptedSignatures.add(v1Provided);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
