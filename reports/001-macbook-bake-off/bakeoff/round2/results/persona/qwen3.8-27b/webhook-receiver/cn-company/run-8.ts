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

  const keyPromise = crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return async (req: Request): Promise<Response> => {
    // 1. Path must be /webhook (ignore query string)
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method must be POST
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Validate and verify the signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonError(401, "invalid_signature");
    }

    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (match === null) {
      return jsonError(401, "invalid_signature");
    }

    const t = match[1];
    const expectedHex = match[2];

    // Read the exact raw body bytes for HMAC computation
    const rawBody = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(rawBody);

    // Build the HMAC message: <t>.<raw body>
    const tBytes = new TextEncoder().encode(t);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    // Compute HMAC-SHA256 and compare in constant time
    const key = await keyPromise;
    const computedBuf = await crypto.subtle.sign("HMAC", key, message);
    const computedBytes = new Uint8Array(computedBuf);
    const expectedBytes = hexToBytes(expectedHex);

    if (!constantTimeEquals(computedBytes, expectedBytes)) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp freshness: reject if > 300 s away from now()
    const nowMs = now().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. Body must be valid JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay protection
    if (seen.has(expectedHex)) {
      return jsonError(409, "replayed");
    }

    // 7. Dispatch the event
    try {
      await onEvent(parsed);
    } catch {
      return jsonError(500, "handler_failed");
    }

    // Only mark as accepted when we respond 204
    seen.add(expectedHex);
    return new Response(null, { status: 204 });
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
