export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent } = options;
  const nowFn = options.now ?? (() => new Date());
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

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, "method_not_allowed");
    }

    // 3. Signature presence and format
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, "invalid_signature");
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, "invalid_signature");
    }

    const t = m[1];
    const providedSig = m[2];

    // Read the raw body once
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Build the message: <t>.<raw body>
    const tBytes = new TextEncoder().encode(t);
    const msg = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    msg.set(tBytes, 0);
    msg[tBytes.length] = 0x2e; // '.'
    msg.set(bodyBytes, tBytes.length + 1);

    // Compute HMAC-SHA256
    const key = await getKey();
    const sigBuf = await crypto.subtle.sign("HMAC", key, msg);
    const computedHex = toHex(new Uint8Array(sigBuf));

    if (!constantTimeEqual(computedHex, providedSig)) {
      return json(401, "invalid_signature");
    }

    // 4. Timestamp freshness (±300 s, inclusive)
    const nowMs = nowFn().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return json(401, "stale_timestamp");
    }

    // 5. JSON validity
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, "invalid_json");
    }

    // 6. Replay detection – key on the full signature header value
    if (seen.has(header)) {
      return json(409, "replayed");
    }

    // 7. Deliver the event
    try {
      await onEvent(event);
      seen.add(header);
      return new Response(null, { status: 204 });
    } catch {
      return json(500, "handler_failed");
    }
  };
}

function json(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += (b < 16 ? "0" : "") + b.toString(16);
  }
  return s;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
