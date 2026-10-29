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

  // Pre-import the key once to optimize performance across requests
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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

    // 3. Signature header check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header must be exactly: t=...,v1=...
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tMatch = parts[0].match(/^t=(\d+)$/);
    const v1Match = parts[1].match(/^v1=([0-9a-f]{64})$/);

    if (!tMatch || !v1Match) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = tMatch[1];
    const v1Hex = v1Match[1];

    // Get raw body bytes for HMAC verification and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Construct verification payload: <t>.<raw body>
    const tBytes = encoder.encode(tStr);
    const payload = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    payload.set(tBytes, 0);
    payload.set([46], tBytes.length); // 46 is ASCII for '.'
    payload.set(bodyBytes, tBytes.length + 1);

    // Convert the hex signature to bytes
    const signatureBytes = new Uint8Array(32);
    for (let i = 0; i < 64; i += 2) {
      signatureBytes[i / 2] = parseInt(v1Hex.substring(i, i + 2), 16);
    }

    const key = await keyPromise;
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      payload,
    );

    if (!isValid) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const timestamp = parseInt(tStr, 10);
    const currentTimestamp = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimestamp - timestamp) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(text);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (seenSignatures.has(v1Hex)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Execution
    try {
      await onEvent(event);
      // Mark as accepted only on success
      seenSignatures.add(v1Hex);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
