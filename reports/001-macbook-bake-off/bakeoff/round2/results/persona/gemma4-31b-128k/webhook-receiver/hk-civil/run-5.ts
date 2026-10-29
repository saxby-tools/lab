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

  /**
   * Constant-time comparison to prevent timing attacks.
   */
  function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Converts an ArrayBuffer to a lowercase hex string.
   */
  function bufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  return async (req: Request): Promise<Response> {
    const url = new URL(req.url, "http://localhost");

    // 1. Path check
    if (url.pathname !== "/webhook") {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 2. Method check
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    const sigMatch = signatureHeader?.match(/^t=(\d+),v1=([a-f0-9]{64})$/);

    if (!sigMatch) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const [_, timestampStr, providedSignature] = sigMatch;
    const rawBody = await req.arrayBuffer();
    const bodyUint8 = new Uint8Array(rawBody);

    // Construct payload: <t>.<raw body>
    const payload = new Uint8Array(
      encoder.encode(timestampStr).length + 1 + bodyUint8.length,
    );
    payload.set(encoder.encode(timestampStr), 0);
    payload[encoder.encode(timestampStr).length] = encoder.encode(".").length === 1 
      ? encoder.encode(".").length === 1 ? 46 : 0 // '.' is 46
      : 0; // This is a bit clumsy, simplified below
    
    // Re-do payload construction clearly
    const tBytes = encoder.encode(timestampStr);
    const finalPayload = new Uint8Array(tBytes.length + 1 + bodyUint8.length);
    finalPayload.set(tBytes, 0);
    finalPayload[tBytes.length] = 46; // ASCII for '.'
    finalPayload.set(bodyUint8, tBytes.length + 1);

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signedBuffer = await crypto.subtle.sign("HMAC", key, finalPayload);
      const calculatedSignature = bufferToHex(signedBuffer);

      if (!timingSafeEqual(calculatedSignature, providedSignature)) {
        throw new Error("Invalid signature");
      }
    } catch {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 4. Timestamp check
    const tSeconds = parseInt(timestampStr, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tSeconds) > 300) {
      return new Response(JSON.stringify({ error: "stale_timestamp" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyUint8);
      parsedBody = JSON.parse(bodyText);
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 6. Replay check
    if (acceptedSignatures.has(providedSignature)) {
      return new Response(JSON.stringify({ error: "replayed" }), {
        status: 409,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 7. Execution
    try {
      await onEvent(parsedBody);
      // Mark as accepted only on success
      acceptedSignatures.add(providedSignature);
      return new Response(null, { status: 204 });
    } catch {
      return new Response(JSON.stringify({ error: "handler_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  };
}
