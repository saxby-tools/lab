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

  // Pre-compute the CryptoKey to avoid re-importing it on every request
  // Note: Since we are in a factory function, we can't easily make this 
  // asynchronous without changing the signature, so we import it inside the handler 
  // or use a promise. For production quality, we'll handle the key import efficiently.
  let cryptoKey: CryptoKey | null = null;
  const getKey = async (): Promise<CryptoKey> => {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return cryptoKey;
  };

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    // 1. Path check
    const url = new URL(req.url);
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

    // Format: t=1767225600,v1=<signature>
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const vPart = parts[1];

    if (!tPart.startsWith("t=") || !vPart.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tValue = tPart.slice(2);
    const providedSig = vPart.slice(3);

    if (providedSig.length !== 64) {
      return jsonResponse(401, "invalid_signature");
    }

    // Read raw body for HMAC verification
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // HMAC calculation: HMAC-SHA256(<t>.<raw body>)
    try {
      const key = await getKey();
      const encoder = new TextEncoder();
      const tBytes = encoder.encode(tValue);
      const dotByte = encoder.encode(".");
      
      const dataToSign = new Uint8Array(tBytes.length + 1 + bodyBytes.length);
      dataToSign.set(tBytes, 0);
      dataToSign.set(dotByte, tBytes.length);
      dataToSign.set(bodyBytes, tBytes.length + 1);

      const signatureBuffer = await crypto.subtle.sign("HMAC", key, dataToSign);
      const signatureArray = new Uint8Array(signatureBuffer);
      
      // Convert to lowercase hex string
      let calculatedSig = "";
      for (let i = 0; i < signatureArray.length; i++) {
        calculatedSig += signatureArray[i].toString(16).padStart(2, "0");
      }

      // Constant-time comparison to prevent timing attacks
      let diff = 0;
      for (let i = 0; i < 64; i++) {
        diff |= providedSig.charCodeAt(i) ^ calculatedSig.charCodeAt(i);
      }

      if (diff !== 0) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tValue, 10);
    if (isNaN(tSeconds)) {
      return jsonResponse(401, "invalid_signature");
    }

    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON body check
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

    // 7. Application Handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only after successful execution
      acceptedSignatures.add(providedSig);
      return new Response(null, { status: 204 });
    } catch {
      return jsonResponse(500, "handler_failed");
    }
  };
}
