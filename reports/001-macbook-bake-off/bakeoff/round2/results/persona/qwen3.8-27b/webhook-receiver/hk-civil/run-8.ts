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
    // 1. Path must be /webhook (ignore query string)
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method must be POST
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature: parse header, verify HMAC
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const match = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (match === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = match[1];
    const v1 = match[2];

    // Read the raw body bytes (consumes the stream)
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Compute HMAC-SHA256 of "<t>.<raw body>"
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const prefix = encoder.encode(tStr + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = toHex(new Uint8Array(sigBuf));

    if (!constantTimeEqual(computedHex, v1)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp must be within 300 seconds of now (inclusive)
    const tSec = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSec * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. Body must be valid JSON
    const bodyStr = new TextDecoder().decode(bodyBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyStr);
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Reject replay of an already-accepted delivery
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch to the application
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Only mark as accepted when we respond 204
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

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
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
