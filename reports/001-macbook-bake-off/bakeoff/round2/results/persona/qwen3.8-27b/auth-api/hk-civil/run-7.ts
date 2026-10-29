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

  const revoked = new Set<string>();

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ---- helpers --------------------------------------------------------

  function base64urlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlDecode(s: string): Uint8Array {
    const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(pad.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
    return r === 0;
  }

  function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function hmac(payload: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return new Uint8Array(sig);
  }

  // ---- token logic ----------------------------------------------------

  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const exp = now().getTime() + 3_600_000;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({ u: username, exp, n: base64urlEncode(nonce) });
    const p = base64urlEncode(encoder.encode(payload));
    const sig = await hmac(p);
    const token = `${p}.${base64urlEncode(sig)}`;
    return { token, expiresAt: new Date(exp).toISOString() };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    if (revoked.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot === -1) return null;
    const p = raw.slice(0, dot);
    const s = raw.slice(dot + 1);
    if (p.length === 0 || s.length === 0) return null;

    // constant-time signature check
    const expected = await hmac(p);
    let actual: Uint8Array;
    try {
      actual = base64urlDecode(s);
    } catch {
      return null;
    }
    if (!ctEqual(expected, actual)) return null;

    // decode payload
    let payload: string;
    try {
      payload = decoder.decode(base64urlDecode(p));
    } catch {
      return null;
    }

    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }

    if (
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof (data as Record<string, unknown>).u !== "string" ||
      typeof (data as Record<string, unknown>).exp !== "number"
    ) return null;

    const exp = (data as Record<string, number>).exp;
    if (now().getTime() >= exp) return null;

    const user = users.find((u) => u.username === (data as Record<string, string>).u);
    return user ?? null;
  }

  function extractToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h) return null;
    if (!h.startsWith("Bearer ")) return null;
    const tok = h.slice(7);
    return tok.length > 0 ? tok : null;
  }

  // ---- route handlers -------------------------------------------------

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }

    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).username !== "string" ||
      typeof (body as Record<string, unknown>).password !== "string"
    ) {
      return json({ error: "invalid_request" }, 400);
    }

    const username = (body as Record<string, string>).username;
    const password = (body as Record<string, string>).password;

    const user = users.find((u) => u.username === username);
    if (!user || user.password !== password) {
      return json({ error: "invalid_credentials" }, 401);
    }

    const { token, expiresAt } = await issueToken(username);
    return json({ token, expiresAt }, 200);
  }

  // ---- main handler ---------------------------------------------------

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      return handleLogin(req);
    }

    // authenticated routes
    const token = extractToken(req);

    if (method === "GET" && path === "/me") {
      if (!token) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ username: user.username, role: user.role }, 200);
    }

    if (method === "GET" && path === "/admin/stats") {
      if (!token) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      const admins = users.filter((u) => u.role === "admin").length;
      return json({ users: users.length, admins }, 200);
    }

    if (method === "POST" && path === "/logout") {
      if (!token) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json({ error: "not_found" }, 404);
  };
}
