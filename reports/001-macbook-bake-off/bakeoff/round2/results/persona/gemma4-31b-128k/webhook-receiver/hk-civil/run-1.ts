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
  const encoder = new TextEncoder();

  // Pre-import the key to avoid repeated overhead per request
  // Since the secret is constant for the lifetime of the handler
  let cryptoKey: CryptoKey | null = null;

  async function getCryptoKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return cryptoKey;
  }

  function jsonResponse(status: number, error: string) {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

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

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const vPart = parts[1];

    if (!tPart.startsWith("t=") || !vPart.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tStr = tPart.slice(2);
    const providedSig = vPart.slice(3);

    // Validate t is numeric and sig is 64 hex chars
    if (!/^\d+$/.test(tStr) || !/^[0-9a-f]{64}$/.test(providedSig)) {
      return jsonResponse(401, "invalid_signature");
    }

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    const key = await getCryptoKey();
    const tBytes = encoder.encode(tStr + ".");
    const payload = new Uint8Array(tBytes.length + bodyBytes.length);
    payload.set(tBytes);
    payload.set(bodyBytes, tBytes.length);

    const signatureBuf = await crypto.subtle.sign("HMAC", key, payload);
    const calculatedSig = bufToHex(signatureBuf);

    if (!timingSafeEqual(calculatedSig, providedSig)) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tValue = parseInt(tStr, 10);
    const currentTimeSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentTimeSeconds - tValue) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validation
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay check
    if (acceptedSignatures.has(providedSig)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Application handler
    try {
      await onEvent(parsedBody);
      // Only mark as accepted if the handler succeeded
      acceptedSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
