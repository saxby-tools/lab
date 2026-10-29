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

  const keyData = new TextEncoder().encode(secret);

  async function handler(req: Request): Promise<Response> {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // Read the raw body once for both signature verification and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // 3. Signature check
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const m = sigHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    if (m === null) {
      return json(401, { error: "invalid_signature" });
    }

    const t = m[1];
    const providedSig = m[2];

    // Derive HMAC key
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
    );

    // Build the message: <t>.<raw body>
    const tBytes = new TextEncoder().encode(t);
    const message = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
    message.set(tBytes, 0);
    message[tBytes.length] = 0x2e; // '.'
    message.set(bodyBytes, tBytes.length + 1);

    const mac = await crypto.subtle.sign("HMAC", key, message);
    const computedHex = toHex(mac);

    if (!constantTimeEqual(computedHex, providedSig)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check (±300 s, inclusive)
    const tSeconds = Number(t);
    const nowMs = now().getTime();
    if (Math.abs(nowMs - tSeconds * 1000) > 300_000) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON validation
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (seen.has(sigHeader)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch event
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Mark accepted only after successful dispatch
    seen.add(sigHeader);

    return new Response(null, { status: 204 });
  }

  return handler;
}

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
