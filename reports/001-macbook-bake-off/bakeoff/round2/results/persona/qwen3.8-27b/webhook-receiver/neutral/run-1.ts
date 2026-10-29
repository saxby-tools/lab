export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const accepted = new Set<string>();

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

    // 3. Signature header presence and shape
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const sigHex = m[2];

    // Read the raw body bytes (needed for both HMAC and JSON parsing)
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Compute HMAC-SHA256 over  t + "." + rawBody  keyed with secret
    const enc = new TextEncoder();
    const keyBytes = enc.encode(options.secret);
    const tBytes = enc.encode(t);

    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const macBuf = await crypto.subtle.sign("HMAC", cryptoKey, message);
    const macBytes = new Uint8Array(macBuf);

    // Constant-time comparison of the 32-byte MAC against the expected hex
    let diff = 0;
    for (let i = 0; i < 32; i++) {
      const expected = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
      diff |= macBytes[i] ^ expected;
    }
    if (diff !== 0) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const nowSec = Math.floor(now().getTime() / 1000);
    const tSec = Number(t);
    if (Math.abs(nowSec - tSec) > 300) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay protection
    if (accepted.has(sigHex)) {
      return json(409, { error: "replayed" });
    }

    // 7. Deliver the event
    try {
      await options.onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    accepted.add(sigHex);
    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
