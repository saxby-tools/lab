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
  const secretBytes = new TextEncoder().encode(secret);

  let keyPromise: Promise<CryptoKey> | null = null;
  function getKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return keyPromise;
  }

  async function computeHmac(
    t: string,
    body: Uint8Array,
  ): Promise<string> {
    const key = await getKey();
    const encoder = new TextEncoder();
    const tBytes = encoder.encode(t);
    const message = new Uint8Array(tBytes.length + 1 + body.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // "."
    message.set(body, tBytes.length + 1);
    const sig = await crypto.subtle.sign("HMAC", key, message);
    const sigBytes = new Uint8Array(sig);
    const hex = new Array(128);
    for (let i = 0; i < 32; i++) {
      const b = sigBytes[i];
      hex[i * 2] = b >= 0x10
        ? (0x30 + ((b >> 4) & 0x0f)) // '0'-'9' or 'a'-'f'
        : 0x30 + b;
      hex[i * 2 + 1] = (b & 0x0f) >= 0x10
        ? 0x61 + ((b & 0x0f) - 0x0a)
        : 0x30 + (b & 0x0f);
    }
    // Build string from char codes
    let result = "";
    for (let i = 0; i < 128; i++) {
      result += String.fromCharCode(hex[i]);
    }
    return result;
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  return async function handler(req: Request): Promise<Response> {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature header – parse and verify
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (!match) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const t = match[1];
    const v1 = match[2];

    // Read the raw body bytes (needed for both HMAC and JSON parsing)
    const bodyBuf = new Uint8Array(await req.arrayBuffer());

    const computed = await computeHmac(t, bodyBuf);
    if (!constantTimeEqual(computed, v1)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const nowMs = now().getTime();
    const tsMs = Number(t) * 1000;
    if (Math.abs(nowMs - tsMs) > 300_000) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay detection
    const sigKey = `${t},${v1}`;
    if (seen.has(sigKey)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Dispatch to application
    try {
      await onEvent(parsed);
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }

    // Only mark as seen on successful acceptance
    seen.add(sigKey);
    return new Response(null, { status: 204 });
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
