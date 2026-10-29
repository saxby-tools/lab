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
  const accepted = new Set<string>();

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

    // 3. Signature must be present, well-formed, and correct
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1]!;
    const v1 = m[2]!;

    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    const encoder = new TextEncoder();
    const prefix = encoder.encode(t + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, message);
    const macHex = toHex(mac);

    if (!safeEqual(macHex, v1)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp must be within ±300 s of now()
    const tNum = Number(t);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tNum * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Reject replays
    if (accepted.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch event
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    accepted.add(v1);
    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
