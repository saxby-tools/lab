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

  // Pre-import the key for performance
  // We'll do this inside the handler or once at creation.
  // Since this is a factory, we can prepare the key here.
  const secretBytes = encoder.encode(secret);

  async function getCryptoKey() {
    return await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

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
    if (!signatureHeader) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Header format: t=1767225600,v1=<signature>
    const parts = signatureHeader.split(",");
    if (parts.length !== 2) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const tPart = parts[0];
    const vPart = parts[1];

    if (!tPart.startsWith("t=") || !vPart.startsWith("v1=")) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const tString = tPart.slice(2);
    const providedSignature = vPart.slice(3);

    // Validate t is decimal digits and signature is 64 hex chars
    if (!/^\d+$/.test(tString) || !/^[0-9a-f]{64}$/.test(providedSignature)) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // Calculate HMAC-SHA256 of <t>.<raw body>
    const key = await getCryptoKey();
    const prefix = encoder.encode(`${tString}.`);
    const payload = new Uint8Array(prefix.length + bodyBytes.length);
    payload.set(prefix);
    payload.set(bodyBytes, prefix.length);

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, payload);
    const computedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (computedSignature !== providedSignature) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 4. Timestamp check
    const tValue = parseInt(tString, 10);
    const nowSeconds = Math.floor(now().getTime() / 1000);
    if (Math.abs(nowSeconds - tValue) > 300) {
      return new Response(JSON.stringify({ error: "stale_timestamp" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // 5. JSON validity check
    let parsedBody: unknown;
    try {
      const text = new TextDecoder().decode(bodyBytes);
      parsedBody = JSON.parse(text);
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

    // 7. Execute application handler
    try {
      await onEvent(parsedBody);
      // Mark as accepted only upon successful return
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
