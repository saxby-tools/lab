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

  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function handle(req: Request): Promise<Response> {
    // 1. Path must be /webhook (ignore query string)
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method must be POST
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Validate and verify the Webhook-Signature header
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = header.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = m[1];
    const providedSig = m[2];

    // Read the raw body bytes (needed for both HMAC and JSON parse)
    const rawBody = new Uint8Array(await req.arrayBuffer());

    // Compute HMAC-SHA256 over  <t>.<raw body>
    const prefix = encoder.encode(tStr + ".");
    const message = new Uint8Array(prefix.length + rawBody.length);
    message.set(prefix, 0);
    message.set(rawBody, prefix.length);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      "HMAC",
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));

    // Convert computed signature to lowercase hex
    let computedHex = "";
    for (let i = 0; i < sig.length; i++) {
      computedHex += sig[i].toString(16).padStart(2, "0");
    }

    if (!constantTimeEqual(computedHex, providedSig)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp staleness check (±300 s, inclusive)
    const nowMs = now().getTime();
    const tMs = Number(tStr) * 1000;
    if (Math.abs(nowMs - tMs) > 300000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Reject replays of an already-accepted delivery
    if (accepted.has(providedSig)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch the event; mark as accepted only on 204
    accepted.add(providedSig);
    try {
      await onEvent(parsed);
    } catch {
      accepted.delete(providedSig);
      return json(500, { error: "handler_failed" });
    }

    return new Response(null, { status: 204 });
  }

  return handle;
}
