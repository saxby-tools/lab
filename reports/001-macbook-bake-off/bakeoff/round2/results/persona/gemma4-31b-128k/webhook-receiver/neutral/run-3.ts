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

  /**
   * Helper to create a JSON response with the required charset
   */
  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Converts a hex string to a Uint8Array
   */
  const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    // Read raw body once for both signature and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // 3. Signature header check
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

    const tValueStr = tPart.slice(2);
    const v1ValueStr = v1Part.slice(3);

    // Basic malformation check (t must be digits, v1 must be 64 hex chars)
    if (!/^\d+$/.test(tValueStr) || !/^[0-9a-f]{64}$/.test(v1ValueStr)) {
      return jsonResponse(401, "invalid_signature");
    }

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      // Payload: <t>.<raw body>
      const tBytes = encoder.encode(tValueStr);
      const dot = encoder.encode(".");
      const payload = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
      payload.set(tBytes);
      payload.set(dot, tBytes.length);
      payload.set(bodyBytes, tBytes.length + 1);

      const sigBytes = hexToBytes(v1ValueStr);
      const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, payload);

      if (!isValid) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check (± 300 seconds)
    const tValue = parseInt(tValueStr, 10);
    const currentSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentSeconds - tValue) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (seenSignatures.has(v1ValueStr)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Event Handler
    try {
      await onEvent(event);
    } catch {
      return jsonResponse(500, "handler_failed");
    }

    // Mark as accepted only on 204 success
    seenSignatures.add(v1ValueStr);
    return new Response(null, { status: 204 });
  };
}
