export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent } = options;
  const now = options.now ?? (() => new Date());
  const seen = new Set<string>();

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = m[1];
    const v1Hex = m[2];

    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Build the signing message: <t>.<raw body>
    const enc = new TextEncoder();
    const prefix = enc.encode(tStr + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const sigBytes = new Uint8Array(sigBuf);
    const expectedBytes = hexToBytes(v1Hex);

    if (!constantTimeEqual(sigBytes, expectedBytes)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const tSec = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSec * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay – atomic check-and-mark (no await between)
    if (seen.has(v1Hex)) {
      return json(409, { error: "replayed" });
    }
    seen.add(v1Hex);

    // 7. Dispatch
    try {
      await onEvent(event);
    } catch {
      seen.delete(v1Hex);
      return json(500, { error: "handler_failed" });
    }

    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.subarray(i * 2, i * 2 + 2), 16);
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
