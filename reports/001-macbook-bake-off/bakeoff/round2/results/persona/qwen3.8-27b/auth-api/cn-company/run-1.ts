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

export function createAuthHandler(options: AuthOptions): (req: Request) => Promise<Response> {
  const { users, secret } = options;
  const now: () => Date = options.now ?? (() => new Date());
  const revokedTokens = new Set<string>();
  const enc = new TextEncoder();

  // ── helpers ──────────────────────────────────────────────────────────

  function toBase64Url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(s: string): Uint8Array | null {
    try {
      const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
      const bin = atob(pad.replace(/-/g, "+").replace(/_/g, "/"));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function hmac256(data: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  }

  function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── token logic ──────────────────────────────────────────────────────

  async function issueToken(user: User): Promise<{ token: string; expiresAt: string }> {
    const iat = now().getTime();
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const payload = JSON.stringify({ u: user.username, i: iat, n: nonce });
    const pBytes = enc.encode(payload);
    const sig = await hmac256(pBytes);
    const token = toBase64Url(pBytes) + "." + toBase64Url(sig);
    return { token, expiresAt: new Date(iat + 3_600_000).toISOString() };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    // must be exactly two dot-separated segments
    const dot = raw.indexOf(".");
    if (dot < 0 || raw.indexOf(".", dot + 1) >= 0) return null;
    const pStr = raw.slice(0, dot);
    const sStr = raw.slice(dot + 1);

    const pBytes = fromBase64Url(pStr);
    if (!pBytes) return null;

    const expected = await hmac256(pBytes);
    const actual = fromBase64Url(sStr);
    if (!actual || !ctEqual(expected, actual)) return null;

    // parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(pBytes)) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (
      typeof payload.u !== "string" ||
      typeof payload.i !== "number" ||
      typeof payload.n !== "string"
    ) return null;

    // expiry – valid strictly before iat + 1 h
    if (now().getTime() >= payload.i + 3_600_000) return null;

    // revocation
    if (revokedTokens.has(raw)) return null;

    // resolve user
    return users.find((u) => u.username === payload.u) ?? null;
  }

  // ── auth header extraction ───────────────────────────────────────────

  function extractToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    return t.length > 0 ? t : null;
  }

  // ── route handlers ───────────────────────────────────────────────────

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).username !== "string" ||
      typeof (body as Record<string, unknown>).password !== "string"
    ) {
      return json(400, { error: "invalid_request" });
    }
    const { username, password } = body as { username: string; password: string };
    const user = users.find((u) => u.username === username);
    if (!user || user.password !== password) {
      return json(401, { error: "invalid_credentials" });
    }
    const { token, expiresAt } = await issueToken(user);
    return json(200, { token, expiresAt });
  }

  async function requireAuth(req: Request): Promise<User | null> {
    const token = extractToken(req);
    if (!token) return null;
    return verifyToken(token);
  }

  async function handleMe(req: Request): Promise<Response> {
    const user = await requireAuth(req);
    if (!user) return json(401, { error: "unauthorized" });
    return json(200, { username: user.username, role: user.role });
  }

  async function handleAdminStats(req: Request): Promise<Response> {
    const user = await requireAuth(req);
    if (!user) return json(401, { error: "unauthorized" });
    if (user.role !== "admin") return json(403, { error: "forbidden" });
    return json(200, {
      users: users.length,
      admins: users.filter((u) => u.role === "admin").length,
    });
  }

  async function handleLogout(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (!token) return json(401, { error: "unauthorized" });
    if (!verifyToken(token)) return json(401, { error: "unauthorized" });
    revokedTokens.add(token);
    return new Response(null, { status: 204 });
  }

  // ── dispatch ─────────────────────────────────────────────────────────

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    const method = req.method;

    if (method === "POST" && pathname === "/login") return handleLogin(req);
    if (method === "GET" && pathname === "/me") return handleMe(req);
    if (method === "GET" && pathname === "/admin/stats") return handleAdminStats(req);
    if (method === "POST" && pathname === "/logout") return handleLogout(req);

    return json(404, { error: "not_found" });
  };
}
