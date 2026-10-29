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

  const seen = new Set<string>();

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const v1 = m[2];

    const rawBody = await req.arrayBuffer();
    const rawBytes = new Uint8Array(rawBody);

    // HMAC-SHA256 over  <t>.<raw_body>  keyed with UTF-8(secret)
    const enc = new TextEncoder();
    const keyData = enc.encode(secret);
    const tBytes = enc.encode(t); // ASCII digits → same as UTF-8

    const input = new Uint8Array(tBytes.length + 1 + rawBytes.length);
    input.set(tBytes, 0);
    input[tBytes.length] = 0x2e; // '.'
    input.set(rawBytes, tBytes.length + 1);

    let computed: Uint8Array;
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sigBuf = await crypto.subtle.sign("HMAC", key, input);
      computed = new Uint8Array(sigBuf);
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const computedHex = toHex(computed);
    if (!constantTimeEqual(computedHex, v1)) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness (±300 s inclusive)
    const tMs = Number(t) * 1000;
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tMs) > 300_000) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay protection
    const replayKey = sigHeader; // full "t=…,v1=…" string
    if (seen.has(replayKey)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }

    seen.add(replayKey);
    return new Response(null, { status: 204 });
  };
}

// ─── helpers ────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(buf: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
