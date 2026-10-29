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

  // Pre-import the HMAC key for performance
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
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

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");

    // 1. Path check
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    // 3. Signature verification
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Format: t=123,v1=hex64
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tValue = tPart.slice(2);
    const v1Value = v1Part.slice(3);

    if (!/^\d+$/.test(tValue) || !/^[a-f0-9]{64}$/.test(v1Value)) {
      return jsonResponse(401, "invalid_signature");
    }

    let bodyBytes: Uint8Array;
    try {
      const arrayBuffer = await req.arrayBuffer();
      bodyBytes = new Uint8Array(arrayBuffer);
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    const key = await keyPromise;
    const signPayload = new Uint8Array(encoder.encode(tValue + ".").length + bodyBytes.length);
    signPayload.set(encoder.encode(tValue + "."), 0);
    signPayload.set(bodyBytes, encoder.encode(tValue + ".").length);

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, signPayload);
    const signatureHex = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (signatureHex !== v1Value) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const timestamp = parseInt(tValue, 10);
    const currentTimeSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimeSeconds - timestamp) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validation
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (acceptedSignatures.has(v1Value)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Event handler
    try {
      await onEvent(event);
    } catch {
      return jsonResponse(500, "handler_failed");
    }

    // Mark as accepted only on success
    acceptedSignatures.add(v1Value);
    return new Response(null, { status: 204 });
  };
}
