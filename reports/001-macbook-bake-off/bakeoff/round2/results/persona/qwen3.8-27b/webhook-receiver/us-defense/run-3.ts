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
  const secretKey = () =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Signature check
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return jsonError(401, "invalid_signature");
    }

    const m = header.match(/^t=([0-9]+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return jsonError(401, "invalid_signature");
    }

    const t = m[1];
    const v1 = m[2];

    // Read raw body bytes (needed for HMAC)
    const rawBody = new Uint8Array(await req.arrayBuffer());

    // Build the HMAC message: "<t>.<raw body>"
    const tDot = new TextEncoder().encode(t + ".");
    const message = new Uint8Array(tDot.length + rawBody.length);
    message.set(tDot, 0);
    message.set(rawBody, tDot.length);

    // Compute expected HMAC-SHA256
    const key = await secretKey();
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));

    // Constant-time comparison with provided signature
    const provided = hexToBytes(v1);
    if (!constantTimeEqual(expected, provided)) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp freshness (±300 seconds, inclusive)
    const tSec = Number.parseInt(t, 10);
    const nowSec = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSec - tSec) > 300) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON body validation
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay detection
    if (acceptedSignatures.has(v1)) {
      return jsonError(409, "replayed");
    }

    // 7. Dispatch event
    try {
      await onEvent(event);
    } catch {
      return jsonError(500, "handler_failed");
    }

    // Mark as accepted only after successful dispatch
    acceptedSignatures.add(v1);
    return new Response(null, { status: 204 });
  };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hi = hex.charCodeAt(i * 2) - 48;
    const lo = hex.charCodeAt(i * 2 + 1) - 48;
    // Map '0'-'9' → 0-9, 'a'-'f' → 10-15
    bytes[i] = ((hi > 9 ? hi - 55 : hi) << 4) | (lo > 9 ? lo - 55 : lo);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
