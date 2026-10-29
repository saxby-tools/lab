export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent } = options;
  const nowFn: () => Date = options.now ?? (() => new Date());

  // ── in-memory state ────────────────────────────────────────────────
  const seen = new Set<string>();
  const secretBytes = new TextEncoder().encode(secret);
  let cachedKey: CryptoKey | null = null;

  // ── helpers (no external state) ─────────────────────────────────────
  function jsonError(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.subarray(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  // ── handler ──────────────────────────────────────────────────────────
  return async (req: Request): Promise<Response> => {
    // 1 – path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonError(404, "not_found");
    }

    // 2 – method
    if (req.method !== "POST") {
      return jsonError(405, "method_not_allowed");
    }

    // 3 – signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonError(401, "invalid_signature");
    }

    const match = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (match === null) {
      return jsonError(401, "invalid_signature");
    }

    const tStr = match[1];
    const providedHex = match[2];

    // read raw body exactly once
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // import (and cache) the HMAC key
    if (cachedKey === null) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }

    // build the message  <t>.<raw body>
    const tBytes = new TextEncoder().encode(tStr);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // "."
    message.set(bodyBytes, tBytes.length + 1);

    const sigBuf = await crypto.subtle.sign("HMAC", cachedKey, message);
    if (!constantTimeEqual(new Uint8Array(sigBuf), hexToBytes(providedHex))) {
      return jsonError(401, "invalid_signature");
    }

    // 4 – timestamp freshness (±300 s, inclusive)
    const nowSec = Math.floor(nowFn().getTime() / 1000);
    const tSec = Number(tStr);
    if (Math.abs(nowSec - tSec) > 300) {
      return jsonError(401, "stale_timestamp");
    }

    // 5 – JSON validation
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return jsonError(400, "invalid_json");
    }

    // 6 – replay detection
    if (seen.has(providedHex)) {
      return jsonError(409, "replayed");
    }

    // 7 – dispatch
    try {
      await onEvent(event);
    } catch {
      return jsonError(500, "handler_failed");
    }

    // mark as accepted only on the 204 path
    seen.add(providedHex);

    return new Response(null, { status: 204 });
  };
}
