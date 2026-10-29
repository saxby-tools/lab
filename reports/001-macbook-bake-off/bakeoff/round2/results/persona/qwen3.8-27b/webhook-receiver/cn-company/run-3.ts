export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const now: () => Date = options.now ?? (() => new Date());
  const accepted = new Set<string>();
  const secretBytes = new TextEncoder().encode(options.secret);

  const keyPromise = crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature – missing or malformed
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const providedSig = m[2];

    // Read the raw body bytes (consumes the body once)
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Compute expected HMAC-SHA256 of  <t>.<raw body>
    const tBytes = new TextEncoder().encode(t);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    const key = await keyPromise;
    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const expectedSig = toHex(sigBuf);

    if (expectedSig !== providedSig) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness (±300 s, inclusive)
    const tNum = Number(t);
    const nowSec = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSec - tNum) > 300) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay detection
    if (accepted.has(sigHeader)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await options.onEvent(parsed);
      accepted.add(sigHeader);
      return new Response(null, { status: 204 });
    } catch {
      return json(500, { error: "handler_failed" });
    }
  };

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function toHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }
}
