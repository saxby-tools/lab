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

  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhook") {
      return jsonResponse(404, "not_found");
    }

    if (req.method !== "POST") {
      return jsonResponse(405, "method_not_allowed");
    }

    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header format: t=1767225600,v1=<signature>
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

    if (!/^\d+$/.test(tStr) || !/^[a-f0-9]{64}$/.test(providedSig)) {
      return jsonResponse(401, "invalid_signature");
    }

    // Capture raw body for HMAC calculation
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    try {
      const keyData = encoder.encode(secret);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      // HMAC payload: <t>.<raw body>
      const tBytes = encoder.encode(`${tStr}.`);
      const payload = new Uint8Array(tBytes.length + bodyBytes.length);
      payload.set(tBytes);
      payload.set(bodyBytes, tBytes.length);

      const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, payload);
      const signatureArray = new Uint8Array(signatureBuffer);
      const calculatedSig = Array.from(signatureArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (calculatedSig !== providedSig) {
        return jsonResponse(401, "invalid_signature");
      }
    } catch {
      return jsonResponse(401, "invalid_signature");
    }

    const timestampSeconds = parseInt(tStr, 10);
    const currentSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(currentSeconds - timestampSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    let eventBody: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      eventBody = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    if (acceptedSignatures.has(providedSig)) {
      return jsonResponse(409, "replayed");
    }

    try {
      await onEvent(eventBody);
    } catch {
      return jsonResponse(500, "handler_failed");
    }

    // Only mark as accepted if the handler responded 204
    acceptedSignatures.add(providedSig);
    return new Response(null, { status: 204 });
  };
}
