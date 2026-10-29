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

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const secretBytes = encoder.encode(secret);
  const keyPromise = crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bufferToHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      parts.push(bytes[i]!.toString(16).padStart(2, "0"));
    }
    return parts.join("");
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (!m) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tStr = m[1]!;
    const v1 = m[2]!;

    // Read the raw body once; needed for both HMAC and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Compute HMAC-SHA256 of "<t>.<raw body>"
    const key = await keyPromise;
    const tBytes = encoder.encode(tStr);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // "."
    message.set(bodyBytes, tBytes.length + 1);

    const sig = await crypto.subtle.sign("HMAC", key, message);
    const expectedHex = bufferToHex(sig);

    if (!constantTimeEqual(expectedHex, v1)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness check (±300 s, inclusive)
    const tSec = Number(tStr);
    const nowMs = now().getTime();
    const deltaMs = nowMs - tSec * 1000;
    if (deltaMs > 300_000 || deltaMs < -300_000) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (seen.has(v1)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Deliver the event
    try {
      await onEvent(parsed);
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }

    seen.add(v1);
    return new Response(null, { status: 204 });
  };
}
