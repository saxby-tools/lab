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
  const secretBytes = encoder.encode(secret);

  const handler = async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const header = req.headers.get("Webhook-Signature");
    if (header === null) {
      return json(401, { error: "invalid_signature" });
    }

    const parsed = parseSignatureHeader(header);
    if (parsed === null) {
      return json(401, { error: "invalid_signature" });
    }
    const { t, v1 } = parsed;

    // Read raw body bytes (consumes the body)
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Compute HMAC-SHA256 of "<t>.<raw body>"
    const prefix = encoder.encode(t + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    let computedHex: string;
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, message);
      computedHex = toHex(new Uint8Array(sig));
    } catch {
      return json(401, { error: "invalid_signature" });
    }

    if (!constantTimeEqual(computedHex, v1)) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check
    const nowSec = Math.floor(now().getTime() / 1000);
    const tSec = Number(t);
    if (Math.abs(tSec - nowSec) > 300) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (accepted.has(v1)) {
      return json(409, { error: "replayed" });
    }

    // 7. Deliver event
    try {
      await onEvent(event);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    // Mark as accepted only after successful 204
    accepted.add(v1);
    return new Response(null, { status: 204 });
  };

  return handler;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseSignatureHeader(
  header: string,
): { t: string; v1: string } | null {
  // Exactly two comma-separated fields, no spaces, in order: t=…, v1=…
  const commaIdx = header.indexOf(",");
  if (commaIdx === -1) return null;

  const tPart = header.slice(0, commaIdx);
  const rest = header.slice(commaIdx + 1);

  // Reject if there is another comma in the remainder
  if (rest.includes(",")) return null;

  // t= followed by one or more decimal digits
  if (!tPart.startsWith("t=")) return null;
  const t = tPart.slice(2);
  if (t.length === 0 || !/^\d+$/.test(t)) return null;

  // v1= followed by exactly 64 lowercase hex characters
  if (!rest.startsWith("v1=")) return null;
  const v1 = rest.slice(3);
  if (v1.length !== 64 || !/^[0-9a-f]+$/.test(v1)) return null;

  return { t, v1 };
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
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
