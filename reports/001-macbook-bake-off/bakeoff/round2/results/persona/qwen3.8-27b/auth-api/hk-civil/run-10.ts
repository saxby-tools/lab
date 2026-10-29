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
  const nowFn: () => Date = options.now ?? (() => new Date());
  const users = options.users;
  const secret = options.secret;
  const revoked = new Set<string>();
  let cachedKey: CryptoKey | null = null;

  async function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function b64urlEnc(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += String.fromCharCode(bytes[i]);
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDec(s: string): Uint8Array {
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const bin = atob(b);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function constTimeEq(a: string, b: string): boolean {
    let diff = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const ca = i < a.length ? a.charCodeAt(i) : 0;
      const cb = i < b.length ? b.charCodeAt(i) : 0;
      diff |= ca ^ cb;
    }
    return diff === 0;
  }

  async function issueToken(username: string, iatMs: number): Promise<string> {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const payload = JSON.stringify({ u: username, t: iatMs, n: b64urlEnc(nonce) });
    const pb = new TextEncoder().encode(payload);
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, pb);
    return b64urlEnc(pb) + "." + b64urlEnc(new Uint8Array(sig));
  }

  async function verifyToken(token: string): Promise<User | null> {
    if (revoked.has(token)) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;

    let pb: Uint8Array;
    let sb: Uint8Array;
    try {
      pb = b64urlDec(token.slice(0, dot));
      sb = b64urlDec(token.slice(dot + 1));
    } catch {
      return null;
    }

    const key = await getKey();
    let ok: boolean;
    try {
      ok = await crypto.subtle.verify("HMAC", key, sb, pb);
    } catch {
      return null;
    }
    if (!ok) return null;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(new TextDecoder().decode(pb));
    } catch {
      return null;
    }
    if (typeof obj.u !== "string" || typeof obj.t !== "number") return null;

    const nowMs = nowFn().getTime();
    if (nowMs >= (obj.t as number) + 3_600_000) return null;

    const user = users.find((u) => u.username === obj.u);
    if (!user) return null;

    return user;
  }

  function bearerToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    return t.length ? t : null;
  }

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
    const pwMatch = user ? constTimeEq(user.password, password) : false;
    if (!user || !pwMatch) {
      return json(401, { error: "invalid_credentials" });
    }

    const iat = nowFn().getTime();
    const token = await issueToken(username, iat);
    const expiresAt = new Date(iat + 3_600_000).toISOString();
    return json(200, { token, expiresAt });
  }

  async function handleAuthed(
    req: Request,
    fn: (user: User) => Promise<Response>,
  ): Promise<Response> {
    const token = bearerToken(req);
    if (!token) return json(401, { error: "unauthorized" });
    const user = await verifyToken(token);
    if (!user) return json(401, { error: "unauthorized" });
    return fn(user);
  }

  async function handleMe(req: Request): Promise<Response> {
    return handleAuthed(req, async (user) =>
      json(200, { username: user.username, role: user.role }));
  }

  async function handleAdminStats(req: Request): Promise<Response> {
    return handleAuthed(req, async (user) => {
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      return json(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    });
  }

  async function handleLogout(req: Request): Promise<Response> {
    const token = bearerToken(req);
    if (!token) return json(401, { error: "unauthorized" });
    const user = await verifyToken(token);
    if (!user) return json(401, { error: "unauthorized" });
    revoked.add(token);
    return new Response(null, { status: 204 });
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (m === "POST" && p === "/login") return handleLogin(req);
    if (m === "GET" && p === "/me") return handleMe(req);
    if (m === "GET" && p === "/admin/stats") return handleAdminStats(req);
    if (m === "POST" && p === "/logout") return handleLogout(req);

    return json(404, { error: "not_found" });
  };

  return handler;
}
