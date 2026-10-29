export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const now: () => Date = options.now ?? (() => new Date());
  const seen = new Set<string>();

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const v1 = m[2];

    // Read the raw body once; reuse for both signature verification and JSON parsing
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Compute HMAC-SHA256 of "<t>.<raw body>"
    const enc = new TextEncoder();
    const keyData = enc.encode(options.secret);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const tBytes = enc.encode(t);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[message.byteLength - bodyBytes.length - 1] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const sigBytes = new Uint8Array(sigBuf);
    let expected = "";
    for (let i = 0; i < sigBytes.length; i++) {
      expected += sigBytes[i]!.toString(16).padStart(2, "0");
    }

    // Constant-time comparison to avoid leaking signature match timing
    if (!constantTimeEqual(expected, v1)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check (±300 s, inclusive)
    const tSec = BigInt(t);
    const nowMs = BigInt(now().getTime());
    const tMs = tSec * 1000n;
    const diff = tMs > nowMs ? tMs - nowMs : nowMs - tMs;
    if (diff > 300_000n) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON parse
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await options.onEvent(event);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Only mark as seen after successful dispatch (204 is the only "accepted" response)
    seen.add(v1);
    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
