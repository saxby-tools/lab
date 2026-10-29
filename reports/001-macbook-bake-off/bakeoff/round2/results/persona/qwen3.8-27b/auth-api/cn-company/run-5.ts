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
  const now = options.now ?? (() => new Date());
  const revoked = new Set<string>();

  const userMap = new Map<string, User>();
  for (const u of users) {
    userMap.set(u.username, u);
  }

  const totalUsers = users.length;
  const adminCount = users.filter((u) => u.role === "admin").length;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64Url(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64Url(s: string): Uint8Array {
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  async function hmac(payloadB64: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
    return toB64Url(new Uint8Array(sig));
  }

  function constantTimeEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return null;

    const expected = await hmac(payloadB64);
    if (!constantTimeEq(expected, sigB64)) return null;

    let payloadStr: string;
    try {
      payloadStr = dec.decode(fromB64Url(payloadB64));
    } catch {
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return null;
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as Record<string, unknown>).u !== "string" ||
      typeof (payload as Record<string, unknown>).exp !== "number"
    ) {
      return null;
    }

    const username = (payload as { u: string }).u;
    const exp = (payload as { exp: number }).exp;

    if (now().getTime() >= exp) return null;
    if (revoked.has(token)) return null;

    const user = userMap.get(username);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractToken(req: Request): string | null {
    const auth = req.headers.get("Authorization");
    if (auth === null || !auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    if (token.length === 0 || /\s/.test(token)) return null;
    return token;
  }

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: "invalid_request" });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).username !== "string" ||
      typeof (body as Record<string, unknown>).password !== "string"
    ) {
      return jsonResponse(400, { error: "invalid_request" });
    }

    const { username, password } = body as { username: string; password: string };
    const user = userMap.get(username);
    if (!user || user.password !== password) {
      return jsonResponse(401, { error: "invalid_credentials" });
    }

    const exp = now().getTime() + 3_600_000;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceStr = toB64Url(nonce);

    const payloadJson = JSON.stringify({ u: username, exp, n: nonceStr });
    const payloadB64 = toB64Url(enc.encode(payloadJson));
    const sig = await hmac(payloadB64);
    const token = `${payloadB64}.${sig}`;

    return jsonResponse(200, {
      token,
      expiresAt: new Date(exp).toISOString(),
    });
  }

  async function handleMe(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (token === null) return jsonResponse(401, { error: "unauthorized" });
    const user = await verifyToken(token);
    if (user === null) return jsonResponse(401, { error: "unauthorized" });
    return jsonResponse(200, { username: user.username, role: user.role });
  }

  async function handleAdminStats(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (token === null) return jsonResponse(401, { error: "unauthorized" });
    const user = await verifyToken(token);
    if (user === null) return jsonResponse(401, { error: "unauthorized" });
    if (user.role !== "admin") return jsonResponse(403, { error: "forbidden" });
    return jsonResponse(200, { users: totalUsers, admins: adminCount });
  }

  async function handleLogout(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (token === null) return jsonResponse(401, { error: "unauthorized" });
    const user = await verifyToken(token);
    if (user === null) return jsonResponse(401, { error: "unauthorized" });
    revoked.add(token);
    return new Response(null, { status: 204 });
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (method === "POST" && pathname === "/login") {
      return handleLogin(req);
    }
    if (method === "GET" && pathname === "/me") {
      return handleMe(req);
    }
    if (method === "GET" && pathname === "/admin/stats") {
      return handleAdminStats(req);
    }
    if (method === "POST" && pathname === "/logout") {
      return handleLogout(req);
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
