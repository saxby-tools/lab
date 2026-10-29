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
  const now = options.now ?? (() => new Date());

  const revoked = new Set<string>();
  const adminCount = users.filter((u) => u.role === "admin").length;

  let cachedKey: CryptoKey | null = null;
  async function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return cachedKey;
  }

  function bytesToB64Url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64UrlToBytes(s: string): Uint8Array {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function hmacSign(data: string): Promise<string> {
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return bytesToB64Url(new Uint8Array(sig));
  }

  function ctEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }

  function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function isString(v: unknown): v is string {
    return typeof v === "string";
  }

  async function verifyToken(raw: string): Promise<{ username: string; role: Role } | null> {
    if (revoked.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot === -1 || dot === 0 || dot === raw.length - 1) return null;

    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    const expected = await hmacSign(payloadB64);
    if (!ctEqual(sigB64, expected)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(payloadB64)));
    } catch {
      return null;
    }

    if (!isPlainObject(payload)) return null;
    if (!isString(payload.u) || !isString(payload.exp)) return null;

    const expMs = new Date(payload.exp).getTime();
    if (Number.isNaN(expMs)) return null;
    if (now().getTime() >= expMs) return null;

    const user = users.find((u) => u.username === payload.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }

    if (!isPlainObject(body) || !isString(body.username) || !isString(body.password)) {
      return json({ error: "invalid_request" }, 400);
    }

    const { username, password } = body;
    const user = users.find((u) => u.username === username);

    // Always perform a comparison to avoid leaking username existence via timing.
    const pw = user ? user.password : "\0";
    const pwMatch = user !== null && ctEqual(pw, password);

    if (!pwMatch) {
      return json({ error: "invalid_credentials" }, 401);
    }

    const expTime = new Date(now().getTime() + 60 * 60 * 1000);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceHex = Array.from(nonce, (b) => b.toString(16).padStart(2, "0")).join("");

    const payloadJson = JSON.stringify({
      u: user!.username,
      exp: expTime.toISOString(),
      n: nonceHex,
    });
    const payloadB64 = bytesToB64Url(new TextEncoder().encode(payloadJson));
    const sigB64 = await hmacSign(payloadB64);
    const token = payloadB64 + "." + sigB64;

    return json({ token, expiresAt: expTime.toISOString() }, 200);
  }

  function extractToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    return h.slice(7);
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      return handleLogin(req);
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = extractToken(req);
      if (token === null) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ username: user.username, role: user.role }, 200);
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = extractToken(req);
      if (token === null) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      return json({ users: users.length, admins: adminCount }, 200);
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = extractToken(req);
      if (token === null) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json({ error: "not_found" }, 404);
  };
}
