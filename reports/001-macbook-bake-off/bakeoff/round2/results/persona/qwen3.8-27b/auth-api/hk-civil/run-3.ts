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

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64url(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function unb64url(s: string): Uint8Array {
    const pad = (4 - (s.length % 4)) % 4;
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  let keyCache: CryptoKey | null = null;
  async function key(): Promise<CryptoKey> {
    if (!keyCache) {
      keyCache = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return keyCache;
  }

  async function issue(username: string) {
    const expMs = now().getTime() + 3_600_000;
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);

    const payload = JSON.stringify({ sub: username, exp: expMs, nonce: b64url(nonce) });
    const pb = enc.encode(payload);
    const pEnc = b64url(pb);

    const k = await key();
    const sig = await crypto.subtle.sign("HMAC", k, pb);
    const sEnc = b64url(new Uint8Array(sig));

    return { token: `${pEnc}.${sEnc}`, expiresAt: new Date(expMs).toISOString() };
  }

  async function check(raw: string): Promise<{ username: string; role: Role } | null> {
    if (revoked.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot < 0) return null;
    const pEnc = raw.slice(0, dot);
    const sEnc = raw.slice(dot + 1);
    if (sEnc.includes(".")) return null;

    let pb: Uint8Array, sb: Uint8Array;
    try {
      pb = unb64url(pEnc);
      sb = unb64url(sEnc);
    } catch {
      return null;
    }

    const k = await key();
    if (!(await crypto.subtle.verify("HMAC", k, sb, pb))) return null;

    let p: { sub?: unknown; exp?: unknown };
    try {
      p = JSON.parse(dec.decode(pb));
    } catch {
      return null;
    }

    if (typeof p.sub !== "string" || typeof p.exp !== "number") return null;
    if (now().getTime() >= p.exp) return null;

    const u = users.find((u) => u.username === p.sub);
    if (!u) return null;

    return { username: u.username, role: u.role };
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function authed(req: Request) {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    return check(h.slice(7));
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    // POST /login
    if (m === "POST" && p === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (
        typeof body !== "object" || body === null || Array.isArray(body) ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return json({ error: "invalid_request" }, 400);
      }
      const { username, password } = body as { username: string; password: string };
      const u = users.find((u) => u.username === username && u.password === password);
      if (!u) return json({ error: "invalid_credentials" }, 401);
      const { token, expiresAt } = await issue(u.username);
      return json({ token, expiresAt });
    }

    // GET /me
    if (m === "GET" && p === "/me") {
      const u = await authed(req);
      if (!u) return json({ error: "unauthorized" }, 401);
      return json({ username: u.username, role: u.role });
    }

    // GET /admin/stats
    if (m === "GET" && p === "/admin/stats") {
      const u = await authed(req);
      if (!u) return json({ error: "unauthorized" }, 401);
      if (u.role !== "admin") return json({ error: "forbidden" }, 403);
      const admins = users.filter((u) => u.role === "admin").length;
      return json({ users: users.length, admins });
    }

    // POST /logout
    if (m === "POST" && p === "/logout") {
      const h = req.headers.get("Authorization");
      if (!h || !h.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
      const token = h.slice(7);
      const u = await check(token);
      if (!u) return json({ error: "unauthorized" }, 401);
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json({ error: "not_found" }, 404);
  };
}
