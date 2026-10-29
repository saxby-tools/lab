export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent } = options;
  const nowFn = options.now ?? (() => new Date());
  const seen = new Set<string>();
  const secretBytes = new TextEncoder().encode(secret);
  let keyPromise: Promise<CryptoKey> | undefined;

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = m[1];
    const v1 = m[2];

    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    if (keyPromise === undefined) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    const key = await keyPromise;

    const tBytes = new TextEncoder().encode(tStr);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    const sigBuf = await crypto.subtle.sign("HMAC", key, message);
    const computed = toHex(new Uint8Array(sigBuf));

    if (!ctEqual(computed, v1)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp
    const diffMs = Math.abs(nowFn().getTime() - Number(tStr) * 1000);
    if (diffMs > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay
    if (seen.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Process
    try {
      await onEvent(event);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    seen.add(v1);
    return new Response(null, { status: 204 });
  };

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
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
