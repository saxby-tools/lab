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
  const secretBytes = new TextEncoder().encode(options.secret);
  let keyPromise: Promise<CryptoKey> | null = null;

  return async (req: Request): Promise<Response> => {
    // 1. Path must be /webhook
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method must be POST
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature must be present, well-formed, and valid
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const v1 = m[2];

    const body = new Uint8Array(await req.arrayBuffer());

    if (keyPromise === null) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    const key = await keyPromise;

    // Build the HMAC input: UTF-8 bytes of t, a dot byte, then the raw body
    const tBytes = new TextEncoder().encode(t);
    const msg = new Uint8Array(tBytes.length + 1 + body.length);
    msg.set(tBytes, 0);
    msg[tBytes.length] = 0x2e; // '.'
    msg.set(body, tBytes.length + 1);

    const mac = await crypto.subtle.sign("HMAC", key, msg);
    const macHex = toHex(new Uint8Array(mac));

    if (!safeEqual(macHex, v1)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp must be within ±300 s of now
    const nowMs = now().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Reject replays of previously accepted deliveries
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch to the application
    try {
      await options.onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

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
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
