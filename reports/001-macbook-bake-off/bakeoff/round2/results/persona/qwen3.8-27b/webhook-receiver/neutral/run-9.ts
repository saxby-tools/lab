export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const accepted = new Set<string>();
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);

  function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bufferToHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      hex += (b < 16 ? "0" : "") + b.toString(16);
    }
    return hex;
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function handler(req: Request): Promise<Response> {
    // 1. Path must be /webhook (ignore query string)
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method must be POST
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Parse and verify signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return jsonError(401, "invalid_signature");
    }

    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (!match) {
      return jsonError(401, "invalid_signature");
    }

    const t = match[1];
    const providedSig = match[2];

    // Read the raw body bytes (needed for HMAC verification)
    const rawBodyBuf = await req.arrayBuffer();
    const rawBody = new Uint8Array(rawBodyBuf);

    // Compute HMAC-SHA256 of "<t>.<raw_body>"
    const prefix = encoder.encode(t + ".");
    const message = new Uint8Array(prefix.length + rawBody.length);
    message.set(prefix, 0);
    message.set(rawBody, prefix.length);

    let computedSig: string;
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const mac = await crypto.subtle.sign("HMAC", cryptoKey, message);
      computedSig = bufferToHex(mac);
    } catch {
      return jsonError(401, "invalid_signature");
    }

    if (!constantTimeEqual(computedSig, providedSig)) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp freshness: within 300 s of now (inclusive)
    const nowMs = now().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay detection
    if (accepted.has(providedSig)) {
      return jsonError(409, "replayed");
    }

    // Reserve the signature to block concurrent duplicates
    accepted.add(providedSig);

    // 7. Dispatch the event
    try {
      await onEvent(parsed);
      return new Response(null, { status: 204 });
    } catch {
      // onEvent failed – the delivery is NOT accepted; allow retry
      accepted.delete(providedSig);
      return jsonError(500, "handler_failed");
    }
  }

  return handler;
}
