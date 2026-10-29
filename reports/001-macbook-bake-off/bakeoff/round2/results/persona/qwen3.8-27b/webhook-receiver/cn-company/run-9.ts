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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, "not_found");
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, "method_not_allowed");
    }

    // 3. Signature
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, "invalid_signature");
    }

    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (m === null) {
      return json(401, "invalid_signature");
    }

    const tStr = m[1];
    const v1 = m[2];

    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    const prefix = encoder.encode(tStr + ".");
    const signingData = new Uint8Array(prefix.length + bodyBytes.length);
    signingData.set(prefix, 0);
    signingData.set(bodyBytes, prefix.length);

    const key = await keyPromise;
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signingData));
    const expectedHex = toHex(mac);

    if (!constantTimeEqual(expectedHex, v1)) {
      return json(401, "invalid_signature");
    }

    // 4. Timestamp freshness
    const tSec = Number(tStr);
    const nowSec = now().getTime() / 1000;
    if (Math.abs(nowSec - tSec) > 300) {
      return json(401, "stale_timestamp");
    }

    // 5. JSON body
    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return json(400, "invalid_json");
    }

    // 6. Replay
    if (seen.has(v1)) {
      return json(409, "replayed");
    }

    // 7. Dispatch
    try {
      await onEvent(event);
    } catch {
      return json(500, "handler_failed");
    }

    seen.add(v1);
    return new Response(null, { status: 204 });
  };

  function json(status: number, error: string): Response {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
