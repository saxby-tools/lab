export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let keyPromise: Promise<CryptoKey> | undefined;

  function getKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return keyPromise;
  }

  async function verifySignature(
    t: string,
    body: Uint8Array,
    expectedHex: string,
  ): Promise<boolean> {
    const key = await getKey();

    // Build the signing input: <t> . <raw body>
    const tBytes = encoder.encode(t);
    const signingData = new Uint8Array(tBytes.length + 1 + body.length);
    signingData.set(tBytes, 0);
    signingData[tBytes.length] = 0x2e; // '.'
    signingData.set(body, tBytes.length + 1);

    const sigBuf = await crypto.subtle.sign("HMAC", key, signingData);
    const sigBytes = new Uint8Array(sigBuf);

    if (sigBytes.length !== 32) return false;

    // Constant-time comparison of raw bytes
    let diff = 0;
    for (let i = 0; i < 32; i++) {
      const expected = parseInt(expectedHex.slice(i * 2, i * 2 + 2), 16);
      diff |= sigBytes[i] ^ expected;
    }
    return diff === 0;
  }

  function json(status: number, body: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async function handler(req: Request): Promise<Response> {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature header – parse and verify
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const v1 = m[2];

    const body = new Uint8Array(await req.arrayBuffer());

    const valid = await verifySignature(t, body, v1);
    if (!valid) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const nowMs = now().getTime();
    const tMs = Number(t) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON body
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay detection
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(event);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Only mark as accepted after a successful 204
    seen.add(v1);

    return new Response(null, { status: 204 });
  };
}
