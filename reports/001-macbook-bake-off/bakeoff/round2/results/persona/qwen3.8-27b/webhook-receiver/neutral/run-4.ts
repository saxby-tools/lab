export interface WebhookOptions {
  secret: string;
  onEvent: (event: unknown) => void | Promise<void>;
  now?: () => Date;
}

export function createWebhookHandler(
  options: WebhookOptions,
): (req: Request) => Promise<Response> {
  const { secret, onEvent } = options;
  const nowFn = options.now ?? (() => new Date());
  const acceptedSignatures = new Set<string>();
  const secretBytes = new TextEncoder().encode(secret);
  let cryptoKey: CryptoKey | null = null;

  return async (req: Request): Promise<Response> => {
    // 1. Path
    const url = new URL(req.url);
    if (url.pathname !== "/webhook") {
      return json(404, { error: "not_found" });
    }

    // 2. Method
    if (req.method !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // 3. Signature
    const sigHeader = req.headers.get("Webhook-Signature");
    if (sigHeader === null) {
      return json(401, { error: "invalid_signature" });
    }

    const match = /^t=([0-9]+),v1=([0-9a-f]{64})$/.exec(sigHeader);
    if (!match) {
      return json(401, { error: "invalid_signature" });
    }

    const tStr = match[1];
    const providedSig = match[2];

    // Read the raw body bytes (needed for both signature check and JSON parse)
    const bodyBytes = new Uint8Array(await req.arrayBuffer());

    // Lazily import the HMAC key
    if (!cryptoKey) {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }

    // Compute HMAC-SHA256 over `<t>.<raw body>`
    const prefix = new TextEncoder().encode(tStr + ".");
    const message = new Uint8Array(prefix.length + bodyBytes.length);
    message.set(prefix, 0);
    message.set(bodyBytes, prefix.length);

    const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, message);
    const computedSig = new Uint8Array(sigBuf);

    if (!timingSafeEqual(computedSig, hexToBytes(providedSig))) {
      return json(401, { error: "invalid_signature" });
    }

    // 4. Timestamp staleness
    const nowSeconds = Math.floor(nowFn().getTime() / 1000);
    const tSeconds = Number(tStr);
    if (Number.isNaN(tSeconds) || Math.abs(tSeconds - nowSeconds) > 300) {
      return json(401, { error: "stale_timestamp" });
    }

    // 5. JSON parsing
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // 6. Replay
    if (acceptedSignatures.has(sigHeader)) {
      return json(409, { error: "replayed" });
    }

    // 7. Dispatch
    try {
      await onEvent(parsed);
    } catch {
      return json(500, { error: "handler_failed" });
    }

    acceptedSignatures.add(sigHeader);
    return new Response(null, { status: 204 });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
