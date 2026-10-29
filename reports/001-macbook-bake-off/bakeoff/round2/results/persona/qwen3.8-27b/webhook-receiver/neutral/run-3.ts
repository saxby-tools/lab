export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const nowFn = options.now ?? (() => new Date());
  const accepted = new Set<string>();

  function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
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

  function bufferToHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  const SIG_RE = /^t=(\d+),v1=([0-9a-f]{64})$/;

  async function handler(req: Request): Promise<Response> {
    // 1. Path check (pathname only, ignore query string)
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // Read raw body bytes (needed for both HMAC and JSON parsing)
    const rawBody = new Uint8Array(await req.arrayBuffer());

    // 3. Signature check
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return jsonError(401, "invalid_signature");
    }

    const match = SIG_RE.exec(header);
    if (match === null) {
      return jsonError(401, "invalid_signature");
    }

    const t = match[1];
    const sig = match[2];

    // Build message: <t>.<raw body>
    const tBytes = new TextEncoder().encode(t);
    const message = new Uint8Array(tBytes.length + 1 + rawBody.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(rawBody, tBytes.length + 1);

    // Compute HMAC-SHA256
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(options.secret),
      "HMAC",
      false,
      ["sign"],
    );
    const macBuf = await crypto.subtle.sign("HMAC", key, message);
    const computed = bufferToHex(macBuf);

    if (!constantTimeEqual(computed, sig)) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp check (more than 300 s away is rejected; exactly 300 s is allowed)
    const nowMs = nowFn().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON parsing
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (accepted.has(sig)) {
      return jsonError(409, "replayed");
    }

    // 7. Deliver the event
    try {
      await options.onEvent(parsed);
    } catch {
      return jsonError(500, "handler_failed");
    }

    // Only mark as accepted on successful 204
    accepted.add(sig);
    return new Response(null, { status: 204 });
  }

  return handler;
}
