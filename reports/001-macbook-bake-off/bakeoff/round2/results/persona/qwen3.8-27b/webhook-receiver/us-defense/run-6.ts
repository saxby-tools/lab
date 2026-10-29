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
  const seen = new Set<string>();
  const secretBytes = new TextEncoder().encode(secret);

  const hmacKey = crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  async function handle(req: Request): Promise<Response> {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (!sigHeader) {
      return json(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (!m) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const v1 = m[2];

    // Read the raw body bytes (needed for both HMAC and later JSON parse)
    const bodyBuffer = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuffer);

    // Construct the HMAC message: <t-as-ASCII>.<raw body bytes>
    const tBytes = new TextEncoder().encode(t);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    // Compute HMAC-SHA256
    const key = await hmacKey;
    const computed = await crypto.subtle.sign("HMAC", key, message);
    const computedBytes = new Uint8Array(computed);

    // Constant-time comparison with the provided signature
    const expectedBytes = hexToBytes(v1);
    if (expectedBytes.length !== computedBytes.length) {
      return json(401, { error: "invalid_signature" });
    }
    let diff = 0;
    for (let i = 0; i < computedBytes.length; i++) {
      diff |= computedBytes[i] ^ expectedBytes[i];
    }
    if (diff !== 0) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check
    const tNum = Number(t);
    const nowMs = now().getTime();
    const diffMs = Math.abs(nowMs - tNum * 1000);
    if (diffMs > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Only mark as accepted when we are about to respond 204
    seen.add(v1);
    return new Response(null, { status: 204 });
  }

  return handle;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
