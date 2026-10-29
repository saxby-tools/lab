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
  const accepted = new Set<string>();
  const enc = new TextEncoder();
  const secretBytes = enc.encode(secret);

  return async (req: Request): Promise<Response> => {
    // 1. Path check (pathname only, ignore query string)
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // Read the raw body bytes once; needed for HMAC before JSON parsing.
    const rawBody = new Uint8Array(await req.arrayBuffer());

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return json(401, { error: "invalid_signature" });
    }

    // Exactly two fields, no spaces: t=<digits>,v1=<64 lowercase hex>
    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!m) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const providedHex = m[2];

    // HMAC-SHA256 of "<t>.<raw body>" keyed with UTF-8 bytes of secret
    const tBytes = enc.encode(t + ".");
    const message = new Uint8Array(tBytes.length + rawBody.length);
    message.set(tBytes, 0);
    message.set(rawBody, tBytes.length);

    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
    );
    const computedBuf = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = bufToHex(computedBuf);

    if (!constantTimeEqual(computedHex, providedHex)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check (±300 s, inclusive)
    const nowSec = Math.floor(now().getTime() / 1000);
    const tSec = Number(t);
    if (Math.abs(nowSec - tSec) > 300) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON parse
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay check – add before calling onEvent so concurrent duplicates
    //    are blocked; remove on failure so a 500'd delivery may be retried.
    if (accepted.has(providedHex)) {
      return json(409, { error: "replayed" });
    }
    accepted.add(providedHex);

    // 7. Dispatch
    try {
      await onEvent(event);
    } catch {
      accepted.delete(providedHex);
      return json(500, { error: "handler_failed" });
    }

    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
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
