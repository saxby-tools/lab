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

  const accepted = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let keyPromise: Promise<CryptoKey> | null = null;
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

    // 3. Signature – parse header, verify HMAC
    const raw = req.headers.get("Webhook-Signature");
    if (!raw) {
      return json(401, { error: "invalid_signature" });
    }

    const m = raw.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (!m) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = m[1];
    const sigHex = m[2];

    const bodyBuf = new Uint8Array(await req.arrayBuffer());

    const key = await getKey();
    const prefix = encoder.encode(tStr + ".");
    const message = new Uint8Array(prefix.length + bodyBuf.length);
    message.set(prefix, 0);
    message.set(bodyBuf, prefix.length);

    const mac = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = toHex(new Uint8Array(mac));

    if (!ctEqual(computedHex, sigHex)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const tSec = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSec * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(bodyBuf));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay
    if (accepted.has(sigHex)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    accepted.add(sigHex);
    return new Response(null, { status: 204 });
  };
}

// --- helpers ----------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += buf[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
