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

  const revokedTokens = new Set<string>();
  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.username, u);

  const adminCount = users.filter((u) => u.role === "admin").length;
  const userCount = users.length;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ── helpers ──────────────────────────────────────────────────────

  function b64url(data: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const raw = atob(b);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function hmac(msg: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
    return new Uint8Array(sig);
  }

  function ctEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  function jres(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bearerToken(req: Request): string | null {
    const h = req.headers.get("authorization");
    if (h === null) return null;
    if (!h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    return t.length === 0 ? null : t;
  }

  // ── token lifecycle ──────────────────────────────────────────────

  async function issueToken(username: string, expiryMs: number): Promise<string> {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const payload = JSON.stringify({ u: username, e: expiryMs, n: b64url(nonce) });
    const pB64 = b64url(enc.encode(payload));
    const sB64 = b64url(await hmac(pB64));
    return `${pB64}.${sB64}`;
  }

  async function verifyToken(token: string): Promise<User | null> {
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [pB64, sB64] = parts;
    if (!pB64 || !sB64) return null;

    // constant-time HMAC check
    const expected = b64url(await hmac(pB64));
    if (!ctEq(sB64, expected)) return null;

    // decode & parse payload
    let raw: string;
    try {
      raw = dec.decode(b64urlDecode(pB64));
    } catch {
      return null;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;

    const obj = data as Record<string, unknown>;
    const u = obj.u;
    const e = obj.e;
    if (typeof u !== "string" || typeof e !== "number" || Number.isNaN(e)) return null;

    // expired at or after the expiry instant
    if (now().getTime() >= e) return null;

    const user = userMap.get(u);
    return user ?? null;
  }

  // ── routes ───────────────────────────────────────────────────────

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
      let raw: string;
      try {
        raw = await req.text();
      } catch {
        return jres(400, { error: "invalid_request" });
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return jres(400, { error: "invalid_request" });
      }

      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        return jres(400, { error: "invalid_request" });
      }

      const obj = data as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return jres(400, { error: "invalid_request" });
      }

      const user = userMap.get(obj.username);
      if (!user || user.password !== obj.password) {
        return jres(401, { error: "invalid_credentials" });
      }

      const nowMs = now().getTime();
      const expiry = nowMs + 3_600_000;
      const token = await issueToken(obj.username, expiry);
      const expiresAt = new Date(expiry).toISOString();

      return jres(200, { token, expiresAt });
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      const token = bearerToken(req);
      if (!token) return jres(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return jres(401, { error: "unauthorized" });
      return jres(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      const token = bearerToken(req);
      if (!token) return jres(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return jres(401, { error: "unauthorized" });
      if (user.role !== "admin") return jres(403, { error: "forbidden" });
      return jres(200, { users: userCount, admins: adminCount });
    }

    // POST /logout
    if (path === "/logout" && method === "POST") {
      const token = bearerToken(req);
      if (!token) return jres(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return jres(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jres(404, { error: "not_found" });
  };
}
