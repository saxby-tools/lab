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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const keyBytes = encoder.encode(secret);

  async function verifySignature(
    tStr: string,
    providedV1: string,
    bodyBytes: Uint8Array,
  ): Promise<boolean> {
    const prefix = encoder.encode(tStr + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = toHex(new Uint8Array(sigBuf));
    return constantTimeEqual(computedHex, providedV1);
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return json(404, { error: "not_found" });
    }
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (match === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = match[1]!;
    const v1 = match[2]!;

    const bodyBuffer = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuffer);

    const sigOk = await verifySignature(tStr, v1, bodyBytes);
    if (!sigOk) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness (±300 s, inclusive)
    const tSec = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSec * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON parse
    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay detection
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }
    // Reserve the slot before the async call so concurrent duplicates are caught.
    seen.add(v1);

    // 7. Deliver
    try {
      await onEvent(event);
    } catch {
      seen.delete(v1);
      return json(500, { error: "handler_failed" });
    }

    return new Response(null, { status: 204 });
  };
}

// --- helpers (module-private) ------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += (b < 16 ? "0" : "") + b.toString(16);
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
