export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent } = options;
  const now: () => Date = options.now ?? (() => new Date());
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

    const m = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const sigHex = m[2];

    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      "HMAC",
      false,
      ["sign"],
    );

    const prefix = new TextEncoder().encode(t + ".");
    const msg = new Uint8Array(prefix.length + bodyBytes.length);
    msg.set(prefix, 0);
    msg.set(bodyBytes, prefix.length);

    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
    const sigBytes = hexToBytes(sigHex);

    if (!constantTimeEqual(mac, sigBytes)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const tSec = Number.parseInt(t, 10);
    const nowSec = now().getTime() / 1000;
    if (Math.abs(nowSec - tSec) > 300) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay
    if (seen.has(sigHex)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    seen.add(sigHex);
    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a[i] ^ b[i];
  }
  return r === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
