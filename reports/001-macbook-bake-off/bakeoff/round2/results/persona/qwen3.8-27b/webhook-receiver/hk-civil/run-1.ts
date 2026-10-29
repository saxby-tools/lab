export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const now: () => Date = options.now ?? (() => new Date());
  const seen = new Set<string>();
  let cachedKey: Promise<CryptoKey> | null = null;

  function getKey(): Promise<CryptoKey> {
    if (cachedKey === null) {
      cachedKey = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(options.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
    }
    return cachedKey;
  }

  function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  return async function handler(req: Request): Promise<Response> {
    // 1. Path check
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return jsonError(404, "not_found");
    }
    if (pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonError(401, "invalid_signature");
    }

    const match = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (match === null) {
      return jsonError(401, "invalid_signature");
    }

    const t = match[1];
    const sigHex = match[2];

    // Read the raw body once; reuse for HMAC and JSON parsing
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Verify HMAC-SHA256 of  t + "." + rawBody
    const key = await getKey();
    const prefix = new TextEncoder().encode(t + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const sigBytes = hexToBytes(sigHex);
    let signatureValid = false;
    try {
      signatureValid = await crypto.subtle.verify("HMAC", key, sigBytes, message);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return jsonError(401, "invalid_signature");
    }

    // 4. Timestamp freshness check
    const tNum = Number(t);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tNum * 1000) > 300_000) {
      return jsonError(401, "stale_timestamp");
    }

    // 5. JSON validation
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6. Replay check
    if (seen.has(sigHex)) {
      return jsonError(409, "replayed");
    }

    // 7. Dispatch to application
    try {
      await options.onEvent(event);
    } catch {
      return jsonError(500, "handler_failed");
    }

    // Only mark as accepted when we are about to return 204
    seen.add(sigHex);

    return new Response(null, { status: 204 });
  };
}
