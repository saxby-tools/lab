export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const now: () => Date = options.now ?? (() => new Date());
  const secretBytes = new TextEncoder().encode(options.secret);
  const accepted = new Set<string>();
  let cachedKey: CryptoKey | null = null;

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature check – missing / malformed / mismatch
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = m[1];
    const providedSig = m[2];

    // Read the raw body bytes exactly once; reuse for HMAC and JSON parse.
    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // Compute expected HMAC-SHA256 over  <t>.<raw body>
    const prefix = new TextEncoder().encode(tStr + ".");
    const data = new Uint8Array(prefix.length + bodyBytes.length);
    data.set(prefix, 0);
    data.set(bodyBytes, prefix.length);

    if (cachedKey === null) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        "HMAC",
        false,
        ["sign"],
      );
    }
    const mac = await crypto.subtle.sign("HMAC", cachedKey, data);
    const expectedSig = toHex(new Uint8Array(mac));

    if (!constantTimeEq(providedSig, expectedSig)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness  (±300 s, boundary inclusive)
    const nowMs = now().getTime();
    const tMs = Number(tStr) * 1000;
    if (Math.abs(nowMs - tMs) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON parse
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay guard
    if (accepted.has(sigHeader)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch to application
    try {
      await options.onEvent(event);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Mark accepted only on successful 204.
    accepted.add(sigHeader);
    return new Response(null, { status: 204 });
  };
}

// ---- helpers (module-private, no imports needed) ----

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
