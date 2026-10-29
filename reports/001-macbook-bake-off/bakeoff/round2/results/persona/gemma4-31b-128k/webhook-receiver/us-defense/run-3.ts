export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  // State kept in memory inside the handler closure
  const seenSignatures = new Set<string>();
  const encoder = new TextEncoder();

  // Pre-import the HMAC key to avoid repeating the operation on every request
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  /**
   * Helper to create JSON responses with the required content type.
   */
  const jsonResponse = (status: number, error: string) => {
    return new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Helper to convert an ArrayBuffer to a lowercase hex string.
   */
  const bufToHex = (buf: ArrayBuffer): string => {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
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

    // 3. Signature check
    const signatureHeader = req.headers.get("Webhook-Signature");
    if (!signatureHeader) {
      return jsonResponse(401, "invalid_signature");
    }

    // Header must be exactly "t=...,v1=..." (no spaces)
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return jsonResponse(401, "invalid_signature");
    }

    const tPart = parts[0];
    const v1Part = parts[1];

    if (!tPart.startsWith("t=") || !v1Part.startsWith("v1=")) {
      return jsonResponse(401, "invalid_signature");
    }

    const tValue = tPart.slice(2);
    const v1Value = v1Part.slice(3);

    // Extract raw body for signature verification and JSON parsing
    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    
    // Verify HMAC-SHA256 of "<t>.<raw body>"
    const key = await keyPromise;
    const tBytes = encoder.encode(`${tValue}.`);
    const combined = new Uint8Array(tBytes.length + bodyBytes.length);
    combined.set(tBytes);
    combined.set(bodyBytes, tBytes.length);

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, combined);
    const computedSignature = bufToHex(signatureBuffer);

    if (computedSignature !== v1Value) {
      return jsonResponse(401, "invalid_signature");
    }

    // 4. Timestamp check
    const tSeconds = parseInt(tValue, 10);
    if (isNaN(tSeconds)) {
      return jsonResponse(401, "invalid_signature");
    }

    const currentSeconds = Math.floor((options.now?.() || new Date()).getTime() / 1000);
    if (Math.abs(currentSeconds - tSeconds) > 300) {
      return jsonResponse(401, "stale_timestamp");
    }

    // 5. JSON validity check
    let event: unknown;
    try {
      const bodyText = new TextDecoder().decode(bodyBytes);
      event = JSON.parse(bodyText);
    } catch {
      return jsonResponse(400, "invalid_json");
    }

    // 6. Replay protection
    if (seenSignatures.has(v1Value)) {
      return jsonResponse(409, "replayed");
    }

    // 7. Execute handler
    try {
      await options.onEvent(event);
      
      // Mark as accepted only upon successful completion of onEvent
      seenSignatures.add(v1Value);
      
      return new Response(null, { status: 204 });
    } catch (e) {
      return jsonResponse(500, "handler_failed");
    }
  };
}
