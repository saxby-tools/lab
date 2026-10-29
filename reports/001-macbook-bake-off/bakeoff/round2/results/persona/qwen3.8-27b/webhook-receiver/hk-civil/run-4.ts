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
  let key: CryptoKey | null = null;

  const secretBytes = new TextEncoder().encode(secret);

  async function getKey(): Promise<CryptoKey> {
    if (!key) {
      key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return key;
  }

  function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonError(401, "invalid_signature");
    }

    const match = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (match === null) {
      return jsonError(401, "invalid_signature");
    }

    const t = match[1];
    const v1 = match[2];

    const rawBody = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(rawBody);

    const prefix = new TextEncoder().encode(t + ".");
    const messageBytes = new Uint8Array(prefix.length + bodyBytes.length);
    messageBytes.set(prefix, 0);
    messageBytes.set(bodyBytes, prefix.length);

    const hmacKey = await getKey();
    const signatureBuf = await crypto.subtle.sign(
      "HMAC",
      hmacKey,
      messageBytes,
    );
    const sigBytes = new Uint8Array(signatureBuf);

    let expectedHex = "";
    for (let i = 0; i < sigBytes.length; i++) {
      expectedHex += sigBytes[i].toString(16).padStart(2, "0");
    }

    if (!constantTimeEqual(expectedHex, v1)) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp
    const nowMs = now().getTime();
    const tMs = Number(t) * 1000;
    const diffMs = Math.abs(nowMs - tMs);
    if (diffMs > 300_000) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay
    if (accepted.has(v1)) {
      return jsonError(409, "replayed");
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return jsonError(500, "handler_failed");
    }

    accepted.add(v1);
    return new Response(null, { status: 204 });
  };
}
