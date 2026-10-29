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

  let keyPromise: Promise<CryptoKey> | null = null;
  function getKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
      );
    }
    return keyPromise;
  }

  function jsonResponse(status: number, body: unknown): Response {
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

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return jsonResponse(404, { error: "not_found" });
    }
    if (pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const match = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!match) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const tStr = match[1];
    const providedSig = match[2];

    // Read the raw body bytes once
    const bodyBuffer = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuffer);

    // Compute HMAC-SHA256 of "<t>.<raw body>"
    const key = await getKey();
    const tBytes = new TextEncoder().encode(tStr);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    const computedDigest = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = Array.from(new Uint8Array(computedDigest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (!constantTimeEqual(computedHex, providedSig)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check
    const t = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(t * 1000 - nowMs) > 300_000) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON parsing
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (accepted.has(providedSig)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Dispatch to application
    try {
      await onEvent(parsed);
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }

    // Mark as accepted only on success (204 path)
    accepted.add(providedSig);

    return new Response(null, { status: 204 });
  };
}
