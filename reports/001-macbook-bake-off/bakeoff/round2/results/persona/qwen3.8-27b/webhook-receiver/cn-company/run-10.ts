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

  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function jsonResp(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function ctEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) {
      r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return r === 0;
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResp(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return jsonResp(405, { error: "method_not_allowed" });
    }

    // 3. Signature
    const hdr = req.headers.get("Webhook-Signature");
    if (hdr === null) {
      return jsonResp(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hdr);
    if (m === null) {
      return jsonResp(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const providedSig = m[2];

    const rawBody = new Uint8Array(await req.arrayBuffer());

    const key = await keyPromise;
    const prefix = enc.encode(t + ".");
    const msg = new Uint8Array(prefix.length + rawBody.length);
    msg.set(prefix, 0);
    msg.set(rawBody, prefix.length);

    const sigBuf = await crypto.subtle.sign("HMAC", key, msg);
    const sigHex = Array.from(new Uint8Array(sigBuf), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");

    if (!ctEqual(sigHex, providedSig)) {
      return jsonResp(401, { error: "invalid_signature" });
    }

    // 4. Timestamp
    const tNum = Number(t);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tNum * 1000) > 300_000) {
      return jsonResp(401, { error: "stale_timestamp" });
    }

    // 5. JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(dec.decode(rawBody));
    } catch {
      return jsonResp(400, { error: "invalid_json" });
    }

    // 6. Replay
    if (accepted.has(providedSig)) {
      return jsonResp(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return jsonResp(500, { error: "handler_failed" });
    }

    accepted.add(providedSig);
    return new Response(null, { status: 204 });
  };
}
