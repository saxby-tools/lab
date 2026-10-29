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
  let cachedKey: Promise<CryptoKey> | null = null;

  function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return cachedKey;
  }

  function bytesToHex(buf: Uint8Array): string {
    let out = "";
    for (let i = 0; i < buf.length; i++) {
      out += buf[i]!.toString(16).padStart(2, "0");
    }
    return out;
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature header
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const t = m[1]!;
    const v1 = m[2]!;

    // Read the raw body once; reuse for HMAC and JSON parsing.
    const bodyBuf = await req.arrayBuffer();

    // Build the HMAC message:  t + "." + raw body bytes
    const prefix = new TextEncoder().encode(t + ".");
    const message = new Uint8Array(prefix.length + bodyBuf.byteLength);
    message.set(prefix, 0);
    message.set(new Uint8Array(bodyBuf), prefix.length);

    // Verify HMAC-SHA256
    const key = await getKey();
    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const computed = bytesToHex(new Uint8Array(sigBuf));

    if (!constantTimeEqual(computed, v1)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness (±300 s, inclusive)
    const tNum = Number(t);
    const nowSec = now().getTime() / 1000;
    if (Math.abs(nowSec - tNum) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON body
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay guard – only signatures that produced a 204 are recorded
    if (accepted.has(v1)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Deliver the event
    try {
      await onEvent(parsed);
      accepted.add(v1);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
