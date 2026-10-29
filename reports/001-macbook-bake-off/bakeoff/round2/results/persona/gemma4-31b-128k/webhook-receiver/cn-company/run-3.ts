export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent, now = () => new Date() } = options;
  const acceptedSignatures = new Set<string>();

  // Pre-calculate the text encoder as it's used frequently
  const encoder = new TextEncoder();
  let cryptoKey: CryptoKey | null = null;

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    // 2. Method check
    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    // 3. Signature header check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Expected format: t=1767225600,v1=<signature>
    const match = signatureHeader.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = match[1];
    const providedSig = match[2];

    // We need the raw body bytes for signature verification
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Initialize CryptoKey once per handler lifecycle
    if (!cryptoKey) {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }

    // Construct the string to sign: <t>.<raw body>
    const tBytes = encoder.encode(`${tStr}.`);
    const signPayload = new Uint8Array(tBytes.length + bodyBytes.length);
    signPayload.set(tBytes);
    signPayload.set(bodyBytes, tBytes.length);

    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, signPayload);
    const signatureArray = new Uint8Array(signatureBuffer);
    const calculatedSig = Array.from(signatureArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (calculatedSig !== providedSig) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(text);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(providedSig)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Execute handler
    try {
      await onEvent(parsedBody);
      // Only mark as accepted if onEvent succeeded and we are about to return 204
      acceptedSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
