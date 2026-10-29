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
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Signature check
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return jsonError(401, "invalid_signature");
    }

    const m = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return jsonError(401, "invalid_signature");
    }

    const t = m[1];
    const providedSig = m[2];

    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    // Message is "<t>.<raw body>" — the dot is a single ASCII byte (0x2E)
    const tBytes = encoder.encode(t + ".");
    const message = new Uint8Array(tBytes.length + bodyBytes.length);
    message.set(tBytes, 0);
    message.set(bodyBytes, tBytes.length);

    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, message);
    const computedSig = toHex(new Uint8Array(sigBuf));

    if (!constantTimeEqual(computedSig, providedSig)) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp freshness check (±300 s, inclusive)
    const tSec = Number(t);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSec * 1000) > 300_000) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON body validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (seen.has(providedSig)) {
      return jsonError(409, "replayed");
    }

    // 7. Dispatch the event
    try {
      await onEvent(parsed);
    } catch {
      return jsonError(500, "handler_failed");
    }

    seen.add(providedSig);
    return new Response(null, { status: 204 });
  };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
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
