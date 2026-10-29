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
  const nowFn: () => Date = options.now ?? (() => new Date());
  const revokedTokens = new Set<string>();
  const HOUR_MS = 3_600_000;

  // ── base64url helpers ──────────────────────────────────────────────
  function b64url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let raw = "";
    for (let i = 0; i < bytes.length; i++) {
      raw += String.fromCharCode(bytes[i]);
    }
    return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDec(s: string): Uint8Array {
    const pad = (4 - (s.length % 4)) % 4;
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── HMAC helper (key imported lazily & cached) ─────────────────────
  let cachedKey: CryptoKey | null = null;

  async function hmac(payloadB64: string): Promise<string> {
    if (!cachedKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    const sig = await crypto.subtle.sign(
      "HMAC",
      cachedKey,
      new TextEncoder().encode(payloadB64),
    );
    return b64url(sig);
  }

  // ── token create / verify ──────────────────────────────────────────
  async function createToken(username: string, issue: Date): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const iat = issue.getTime();
    const jti = b64url(nonce);
    const json = JSON.stringify({ sub: username, iat, jti });
    const payload = b64url(new TextEncoder().encode(json));
    const sig = await hmac(payload);
    return `${payload}.${sig}`;
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return null;

    // integrity
    const expected = await hmac(payloadB64);
    if (expected !== sigB64) return null;

    // revocation
    if (revokedTokens.has(token)) return null;

    // decode payload
    let json: string;
    try {
      json = new TextDecoder().decode(b64urlDec(payloadB64));
    } catch {
      return null;
    }

    let data: { sub?: unknown; iat?: unknown };
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }

    if (typeof data.sub !== "string" || typeof data.iat !== "number") return null;

    // expiry: valid strictly before iat + 1 h
    if (nowFn().getTime() >= (data.iat as number) + HOUR_MS) return null;

    // user lookup (fixed list, usernames unique & case-sensitive)
    const user = users.find((u) => u.username === data.sub);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  // ── response helper ────────────────────────────────────────────────
  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── auth extraction ────────────────────────────────────────────────
  function extractToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (header === null) return null;
    const m = /^Bearer (\S+)$/.exec(header);
    if (!m) return null;
    return m[1];
  }

  // ── main handler ───────────────────────────────────────────────────
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_request" });
      }
      if (
        typeof body !== "object" || body === null || Array.isArray(body)
      ) {
        return json(400, { error: "invalid_request" });
      }
      const obj = body as Record<string, unknown>;
      if (
        typeof obj.username !== "string" || typeof obj.password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }
      const user = users.find(
        (u) => u.username === obj.username && u.password === obj.password,
      );
      if (!user) return json(401, { error: "invalid_credentials" });

      const now = nowFn();
      const token = await createToken(user.username, now);
      const expiresAt = new Date(now.getTime() + HOUR_MS).toISOString();
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = extractToken(req);
      if (!token) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = extractToken(req);
      if (!token) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = extractToken(req);
      if (!token) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // everything else
    return json(404, { error: "not_found" });
  };
}
