export type Role = "admin" | "member";

export interface User {
  username: string;
  password: string;
  role: Role;
}

export interface AuthOptions {
  users: User[];
  secret: string;
  now?: () => Date;
}

export function createAuthHandler(
  options: AuthOptions,
): (req: Request) => Promise<Response> {
  const { users, secret } = options;
  const now: () => Date = options.now ?? (() => new Date());
  const encoder = new TextEncoder();

  // Mutable state kept inside the closure
  const revokedTokens = new Set<string>();
  let cachedKey: CryptoKey | null = null;

  async function getKey(): Promise<CryptoKey> {
    if (cachedKey === null) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  function toBase64Url(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(s: string): Uint8Array {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function issueToken(username: string): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const issuedAt = now();
    const exp = new Date(issuedAt.getTime() + 3_600_000);
    const expStr = exp.toISOString();

    // Random 16-byte nonce guarantees uniqueness even for the same
    // user at the same instant.
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceB64 = toBase64Url(nonce.buffer);

    const payload = JSON.stringify({ u: username, exp: expStr, n: nonceB64 });
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    // Token = base64url(payload) + "." + base64url(hmac)
    // Every character is in [A-Za-z0-9._-] — visible ASCII, no spaces.
    const payloadB64 = toBase64Url(encoder.encode(payload).buffer);
    const sigB64 = toBase64Url(sig);
    const token = payloadB64 + "." + sigB64;

    return { token, expiresAt: expStr };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    // Must not be revoked
    if (revokedTokens.has(raw)) return null;

    // Split on the last dot (the payload is base64url so it contains no dots)
    const dot = raw.lastIndexOf(".");
    if (dot <= 0 || dot === raw.length - 1) return null;

    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    // Recover the canonical payload string
    let payloadJson: string;
    try {
      payloadJson = new TextDecoder().decode(fromBase64Url(payloadB64));
    } catch {
      return null;
    }

    // Verify HMAC
    const key = await getKey();
    const expected = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadJson),
    );
    if (toBase64Url(expected) !== sigB64) return null;

    // Parse and validate payload
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      payload = parsed;
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.exp !== "string") {
      return null;
    }

    // Expiry: valid strictly before the instant one hour after issuance
    const expMs = Date.parse(payload.exp);
    if (Number.isNaN(expMs)) return null;
    if (now().getTime() >= expMs) return null;

    // Resolve user
    const user = users.find((u) => u.username === payload.u);
    if (user === undefined) return null;

    return user;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (header === null || !header.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    if (token.length === 0) return null;
    return token;
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ---- POST /login ----
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_request" });
      }

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return json(400, { error: "invalid_request" });
      }

      const record = body as Record<string, unknown>;
      if (
        typeof record.username !== "string" ||
        typeof record.password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }

      const user = users.find(
        (u) => u.username === record.username && u.password === record.password,
      );
      if (user === undefined) {
        return json(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await issueToken(user.username);
      return json(200, { token, expiresAt });
    }

    // ---- GET /me ----
    if (method === "GET" && path === "/me") {
      const token = extractToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // ---- GET /admin/stats ----
    if (method === "GET" && path === "/admin/stats") {
      const token = extractToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (user === null) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // ---- POST /logout ----
    if (method === "POST" && path === "/logout") {
      const token = extractToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (user === null) return json(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // ---- Everything else ----
    return json(404, { error: "not_found" });
  };
}
