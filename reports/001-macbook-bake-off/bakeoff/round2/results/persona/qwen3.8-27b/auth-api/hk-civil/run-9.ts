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

  // ── helpers ──────────────────────────────────────────────────────

  function jsonBody(obj: unknown, status: number): Response {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function b64urlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array | null {
    if (s.length === 0 || /[^A-Za-z0-9\-_]/.test(s)) return null;
    try {
      let b = s.replace(/-/g, "+").replace(/_/g, "/");
      b += "=".repeat((4 - (b.length % 4)) % 4);
      const binary = atob(b);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function hmac(data: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  }

  async function issueToken(
    username: string,
    ts: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const jti = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const payload = JSON.stringify({ sub: username, iat: ts, jti });
    const pBytes = new TextEncoder().encode(payload);
    const sig = await hmac(pBytes);
    const token = `${b64urlEncode(pBytes)}.${b64urlEncode(sig)}`;
    const expiresAt = new Date(ts + 3_600_000).toISOString();
    return { token, expiresAt };
  }

  async function verifyToken(
    raw: string,
  ): Promise<{ username: string; role: Role; jti: string } | null> {
    // exactly one dot
    const dot = raw.indexOf(".");
    if (dot < 0 || raw.indexOf(".", dot + 1) >= 0) return null;

    const pBytes = b64urlDecode(raw.slice(0, dot));
    if (!pBytes) return null;

    // constant-time signature comparison
    const expected = b64urlEncode(await hmac(pBytes));
    const provided = raw.slice(dot + 1);
    if (expected.length !== provided.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    }
    if (diff !== 0) return null;

    // parse payload
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(pBytes));
    } catch {
      return null;
    }
    if (
      typeof payload !== "object" || payload === null || Array.isArray(payload)
    ) return null;
    const p = payload as Record<string, unknown>;
    if (
      typeof p.sub !== "string" ||
      typeof p.iat !== "number" ||
      typeof p.jti !== "string"
    ) return null;

    // expiry: valid strictly before iat + 1 h
    if (nowFn().getTime() >= p.iat + 3_600_000) return null;

    // revocation
    if (revoked.has(p.jti)) return null;

    // user must still exist
    const user = users.find((u) => u.username === p.sub);
    if (!user) return null;

    return { username: user.username, role: user.role, jti: p.jti };
  }

  function extractToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h) return null;
    const prefix = "Bearer ";
    if (!h.startsWith(prefix)) return null;
    const t = h.slice(prefix.length);
    return t.length > 0 ? t : null;
  }

  // ── handler ────────────────────────────────────────────────────────

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
        return jsonBody({ error: "invalid_request" }, 400);
      }
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return jsonBody({ error: "invalid_request" }, 400);
      }

      const { username, password } = body as {
        username: string;
        password: string;
      };

      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return jsonBody({ error: "invalid_credentials" }, 401);
      }

      const ts = nowFn().getTime();
      const { token, expiresAt } = await issueToken(username, ts);
      return jsonBody({ token, expiresAt }, 200);
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const raw = extractToken(req);
      if (!raw) return jsonBody({ error: "unauthorized" }, 401);
      const auth = await verifyToken(raw);
      if (!auth) return jsonBody({ error: "unauthorized" }, 401);
      return jsonBody({ username: auth.username, role: auth.role }, 200);
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const raw = extractToken(req);
      if (!raw) return jsonBody({ error: "unauthorized" }, 401);
      const auth = await verifyToken(raw);
      if (!auth) return jsonBody({ error: "unauthorized" }, 401);
      if (auth.role !== "admin") return jsonBody({ error: "forbidden" }, 403);
      const admins = users.filter((u) => u.role === "admin").length;
      return jsonBody({ users: users.length, admins }, 200);
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const raw = extractToken(req);
      if (!raw) return jsonBody({ error: "unauthorized" }, 401);
      const auth = await verifyToken(raw);
      if (!auth) return jsonBody({ error: "unauthorized" }, 401);
      revoked.add(auth.jti);
      return new Response(null, { status: 204 });
    }

    // everything else
    return jsonBody({ error: "not_found" }, 404);
  };
}
