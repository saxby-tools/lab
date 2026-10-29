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

  const keyMaterial = new TextEncoder().encode(secret);
  let keyPromise: Promise<CryptoKey> | undefined;

  const seen = new Set<string>();

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async function handler(req: Request): Promise<Response> {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // Read raw body once (needed for HMAC and later for JSON parsing)
    const bodyBuffer = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuffer);

    // 3. Signature header presence & format
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const match = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (match === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = match[1];
    const sigHex = match[2];

    // Compute HMAC-SHA256 of "<t>.<raw body>"
    const tBytes = new TextEncoder().encode(tStr);
    const messageBytes = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    messageBytes.set(tBytes, 0);
    messageBytes[tBytes.length] = 0x2e; // '.'
    messageBytes.set(bodyBytes, tBytes.length + 1);

    if (keyPromise === undefined) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }

    const key = await keyPromise;
    const computed = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, messageBytes),
    );

    // Parse the provided hex signature into bytes
    const provided = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      provided[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
    }

    // Constant-time comparison
    let diff = 0;
    for (let i = 0; i < 32; i++) {
      diff |= computed[i] ^ provided[i];
    }
    if (diff !== 0) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness (±300 s, inclusive)
    const t = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - t * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON body validation
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBuffer));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay detection
    if (seen.has(sigHex)) {
      return json(409, { error: "replayed" });
    }

    // 7. Deliver the event
    try {
      await onEvent(event);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Only mark as accepted when we respond 204
    seen.add(sigHex);

    return new Response(null, { status: 204 });
  };
}
