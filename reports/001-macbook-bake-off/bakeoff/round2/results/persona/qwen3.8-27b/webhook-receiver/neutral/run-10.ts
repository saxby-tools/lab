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

  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

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
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (match === null) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = match[1];
    const expectedSig = match[2];

    const bodyBuf = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(bodyBuf);

    // HMAC over  <t>.<raw body>
    const prefix = new TextEncoder().encode(tStr + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const key = await keyPromise;
    const macBuf = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = toHex(macBuf);

    if (!ctEqual(computedHex, expectedSig)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp freshness
    const tSec = Number(tStr);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSec * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON body
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay
    if (seen.has(expectedSig)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Only mark as accepted after a successful 204 path
    seen.add(expectedSig);

    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const parts: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = bytes[i]!.toString(16).padStart(2, "0");
  }
  return parts.join("");
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
