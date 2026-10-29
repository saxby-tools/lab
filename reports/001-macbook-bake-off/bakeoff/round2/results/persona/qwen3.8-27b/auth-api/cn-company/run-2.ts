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

  const revokedTokens = new Set<string>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const secretBytes = enc.encode(secret);

  let cachedKey: CryptoKey | null = null;

  async function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  function toB64url(data: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < data.length; i++) {
      bin += String.fromCharCode(data[i]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(s: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    try {
      const bin = atob(padded);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  async function makeToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const nowMs = nowFn().getTime();
    const expMs = nowMs + 3_600_000;
    const nonce = crypto.getRandomValues(new Uint8Array(16));

    const payloadStr = JSON.stringify({ u: username, e: expMs, n: toB64url(nonce) });
    const payloadBytes = enc.encode(payloadStr);

    const key = await getKey();
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));

    const token = toB64url(payloadBytes) + "." + toB64url(sig);
    const expiresAt = new Date(expMs).toISOString();
    return { token, expiresAt };
  }

  async function checkToken(raw: string): Promise<{ username: string; role: Role } | null> {
    if (revokedTokens.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot < 0) return null;
    const p = raw.slice(0, dot);
    const s = raw.slice(dot + 1);
    if (s.includes(".")) return null;

    const pBytes = fromB64url(p);
    const sBytes = fromB64url(s);
    if (!pBytes || !sBytes) return null;

    const key = await getKey();
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, pBytes));
    if (!ctEqual(expected, sBytes)) return null;

    let payload: { u?: unknown; e?: unknown };
    try {
      payload = JSON.parse(dec.decode(pBytes));
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.e !== "number") return null;

    if (nowFn().getTime() >= payload.e) return null;

    const user = users.find((u) => u.username === payload.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function getBearer(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    return t.length > 0 ? t : null;
  }

  async function handler(req: Request): Promise<Response> {
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
        typeof body !== "object" ||
        body === null ||
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
      const { token, expiresAt } = await makeToken(username);
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = getBearer(req);
      if (!token) return json(401, { error: "unauthorized" });
      const user = await checkToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = getBearer(req);
      if (!token) return json(401, { error: "unauthorized" });
      const user = await checkToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = getBearer(req);
      if (!token) return json(401, { error: "unauthorized" });
      const user = await checkToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // 404 for everything else
    return json(404, { error: "not_found" });
  }

  return handler;
}
