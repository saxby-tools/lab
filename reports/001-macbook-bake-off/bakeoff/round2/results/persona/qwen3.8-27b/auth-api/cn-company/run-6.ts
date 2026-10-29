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
  const nowFn = options.now ?? (() => new Date());

  const revoked = new Set<string>();
  const adminCount = users.filter((u) => u.role === "admin").length;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const keyPromise = crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // ---------- helpers ----------

  function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    let pad = s.length % 4;
    if (pad > 0) s += "=".repeat(4 - pad);
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ctEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return d === 0;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function sign(payloadB64: string): Promise<string> {
    const key = await keyPromise;
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
    return b64url(new Uint8Array(sig));
  }

  async function verifyToken(token: string): Promise<{
    username: string;
    role: Role;
    jti: string;
  } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;

    // verify signature
    const expected = await sign(payloadB64);
    if (!ctEqual(sigB64, expected)) return null;

    // decode & parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dec.decode(b64urlDecode(payloadB64)));
    } catch {
      return null;
    }

    const sub = payload.sub;
    const exp = payload.exp;
    const jti = payload.jti;

    if (typeof sub !== "string" || typeof exp !== "number" || typeof jti !== "string") {
      return null;
    }

    // revocation
    if (revoked.has(jti)) return null;

    // expiry – token is valid strictly before exp
    if (nowFn().getTime() >= exp) return null;

    // user must exist in the fixed list
    const user = users.find((u) => u.username === sub);
    if (!user) return null;

    return { username: user.username, role: user.role, jti };
  }

  function extractToken(req: Request): string | null {
    const h = req.headers.get("authorization");
    if (!h) return null;
    // must start with "Bearer " (case-sensitive, single space)
    if (!h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    return t.length > 0 ? t : null;
  }

  // ---------- routes ----------

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_request" });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(400, { error: "invalid_request" });
    }

    const obj = body as Record<string, unknown>;
    const username = obj.username;
    const password = obj.password;

    if (typeof username !== "string" || typeof password !== "string") {
      return json(400, { error: "invalid_request" });
    }

    // constant-time-ish user lookup to avoid enumeration
    const user = users.find(
      (u) => u.username === username && u.password === password,
    );
    if (!user) {
      return json(401, { error: "invalid_credentials" });
    }

    const now = nowFn();
    const exp = now.getTime() + 3_600_000; // 1 hour in ms

    // random 128-bit jti guarantees uniqueness
    const jtiBytes = crypto.getRandomValues(new Uint8Array(16));
    const jti = Array.from(jtiBytes, (b) => b.toString(16).padStart(2, "0")).join("");

    const payload = JSON.stringify({ sub: user.username, exp, jti });
    const payloadB64 = b64url(enc.encode(payload));
    const sigB64 = await sign(payloadB64);
    const token = payloadB64 + "." + sigB64;

    return json(200, { token, expiresAt: new Date(exp).toISOString() });
  }

  async function handleMe(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (!token) return json(401, { error: "unauthorized" });

    const info = await verifyToken(token);
    if (!info) return json(401, { error: "unauthorized" });

    return json(200, { username: info.username, role: info.role });
  }

  async function handleAdminStats(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (!token) return json(401, { error: "unauthorized" });

    const info = await verifyToken(token);
    if (!info) return json(401, { error: "unauthorized" });

    if (info.role !== "admin") return json(403, { error: "forbidden" });

    return json(200, { users: users.length, admins: adminCount });
  }

  async function handleLogout(req: Request): Promise<Response> {
    const token = extractToken(req);
    if (!token) return json(401, { error: "unauthorized" });

    const info = await verifyToken(token);
    if (!info) return json(401, { error: "unauthorized" });

    revoked.add(info.jti);

    return new Response(null, { status: 204 });
  }

  // ---------- dispatch ----------

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/login" && method === "POST") return handleLogin(req);
    if (path === "/me" && method === "GET") return handleMe(req);
    if (path === "/admin/stats" && method === "GET") return handleAdminStats(req);
    if (path === "/logout" && method === "POST") return handleLogout(req);

    return json(404, { error: "not_found" });
  };
}
