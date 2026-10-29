export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const seen = new Set<string>();
  const enc = new TextEncoder();
  const secretBytes = enc.encode(options.secret);

  function toHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
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

  function jsonErr(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async function handler(req: Request): Promise<Response> {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonErr(404, "not_found");
    }

    // 2. Method
    if (req.method !== "POST") {
      return jsonErr(405, "method_not_allowed");
    }

    // 3. Signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return jsonErr(401, "invalid_signature");
    }

    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!m) {
      return jsonErr(401, "invalid_signature");
    }

    const t = m[1];
    const expectedSig = m[2];

    const rawBody = new Uint8Array(await req.arrayBuffer());

    // Build the message: <t>.<raw body>
    const tBytes = enc.encode(t);
    const message = new Uint8Array(tBytes.length + 1 + rawBody.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(rawBody, tBytes.length + 1);

    let actualSig: string;
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sigBuf = await crypto.subtle.sign("HMAC", key, message);
      actualSig = toHex(sigBuf);
    } catch {
      return jsonErr(401, "invalid_signature");
    }

    if (!constantTimeEqual(actualSig, expectedSig)) {
      return jsonErr(401, "invalid_signature");
    }

    // 4. Timestamp
    const nowMs = now().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return jsonErr(401, "stale_timestamp");
    }

    // 5. JSON
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonErr(400, "invalid_json");
    }

    // 6. Replay
    if (seen.has(expectedSig)) {
      return jsonErr(409, "replayed");
    }

    // 7. Dispatch
    try {
      await options.onEvent(body);
      seen.add(expectedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonErr(500, "handler_failed");
    }
  };
}
