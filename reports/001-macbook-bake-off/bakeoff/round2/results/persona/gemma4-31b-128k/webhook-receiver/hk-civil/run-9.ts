export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const encoder = new TextEncoder();
  const acceptedSignatures = new Set<string>();
  let cachedKey: CryptoKey | null = null;

  async function getCryptoKey(): Promise<CryptoKey> {
    if (cachedKey) return cachedKey;
    cachedKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return cachedKey;
  }

  function jsonResponse(status: number, body: { error: string } | null) {
    if (body === null) {
      return new Response(null, { status });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, { error: "not_found" });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" });
    }

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // Regex matches exactly: t=<digits>,v1=<64 hex chars>
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    const [, tStr, v1] = match;
    const rawBody = new Uint8Array(await req.arrayBuffer());

    try {
      const key = await getCryptoKey();
      const payload = new Uint8Array(encoder.encode(`${tStr}.`).length + rawBody.length);
      payload.set(encoder.encode(`${tStr}.`), 0);
      payload.set(rawBody, encoder.encode(`${tStr}.`).length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
      const signatureHex = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (signatureHex !== v1) {
        return jsonResponse(401, { error: "invalid_signature" });
      }
    } catch {
      return jsonResponse(401, { error: "invalid_signature" });
    }

    // 4. Timestamp check
    const t = parseInt(tStr, 10);
    const currentTimestamp = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimestamp - t) > 300) {
      return jsonResponse(401, { error: "stale_timestamp" });
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(rawBody);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    // 6. Replay check
    if (acceptedSignatures.has(v1)) {
      return jsonResponse(409, { error: "replayed" });
    }

    // 7. Process event
    try {
      await onEvent(parsedBody);
      acceptedSignatures.add(v1);
      return jsonResponse(204, null);
    } catch {
      return jsonResponse(500, { error: "handler_failed" });
    }
  };
}
