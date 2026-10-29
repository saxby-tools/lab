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

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, "not_found");
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, "method_not_allowed");
    }

    // 3. Signature
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, "invalid_signature");
    }

    const parts = header.split(",");
    if (parts.length !== 2) {
      return json(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=")) {
      return json(401, "invalid_signature");
    }
    const t = tPart.slice(2);
    if (t.length === 0 || !/^\d+$/.test(t)) {
      return json(401, "invalid_signature");
    }

    if (!v1Part.startsWith("v1=")) {
      return json(401, "invalid_signature");
    }
    const v1 = v1Part.slice(3);
    if (v1.length !== 64 || !/^[0-9a-f]+$/.test(v1)) {
      return json(401, "invalid_signature");
    }

    // Read raw body bytes
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Compute HMAC-SHA256 of  t + "." + rawBody
    const enc = new TextEncoder();
    const prefix = enc.encode(t + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, message);
    const computed = toHex(mac);

    if (!timingSafeEqual(computed, v1)) {
      return json(401, "invalid_signature");
    }

    // 4. Timestamp
    const tSec = Number(t);
    if (!Number.isFinite(tSec)) {
      return json(401, "stale_timestamp");
    }
    const nowMs = now().getTime();
    const tMs = tSec * 1000;
    if (Math.abs(tMs - nowMs) > 300_000) {
      return json(401, "stale_timestamp");
    }

    // 5. JSON
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      return json(400, "invalid_json");
    }

    // 6. Replay
    if (seen.has(v1)) {
      return json(409, "replayed");
    }

    // 7. Dispatch
    try {
      await options.onEvent(event);
    } catch {
      return json(500, "handler_failed");
    }

    seen.add(v1);
    return new Response(null, { status: 204 });
  };
}

function json(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
