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

  // Cache the HMAC key so we don't re-import on every request
  let cachedKey: Promise<CryptoKey> | null = null;
  function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  function b64url(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function issueToken(user: User): Promise<{ token: string; expiresAt: string }> {
    const now = nowFn();
    const exp = now.getTime() + 3_600_000;

    // 16-byte random nonce guarantees uniqueness even at the same millisecond
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);

    const payload = JSON.stringify({ u: user.username, e: exp, n: b64url(nonce.buffer) });
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));

    const token = b64url(enc.encode(payload).buffer) + "." + b64url(sig);
    const expiresAt = new Date(exp).toISOString();

    return { token, expiresAt };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    if (revokedTokens.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot < 1 || dot >= raw.length - 1) return null; // need non-empty payload and sig

    let payloadText: string;
    let sigBytes: Uint8Array;
    try {
      payloadText = dec.decode(b64urlDecode(raw.slice(0, dot)));
      sigBytes = b64urlDecode(raw.slice(dot + 1));
    } catch {
      return null;
    }

    let valid: boolean;
    try {
      valid = await crypto.subtle.verify(
        "HMAC",
        await getKey(),
        sigBytes,
        enc.encode(payloadText),
      );
    } catch {
      return null;
    }
    if (!valid) return null;

    let data: unknown;
    try {
      data = JSON.parse(payloadText);
    } catch {
      return null;
    }

    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const obj = data as Record<string, unknown>;
    if (typeof obj.u !== "string" || typeof obj.e !== "number") return null;

    // Expired at or after the expiry instant
    if (nowFn().getTime() >= obj.e) return null;

    const user = users.find((u) => u.username === obj.u);
    return user ?? null;
  }

  function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ---- POST /login ----
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "invalid_request" }, 400);
      }

      const b = body as Record<string, unknown>;
      if (typeof b.username !== "string" || typeof b.password !== "string") {
        return json({ error: "invalid_request" }, 400);
      }

      const user = users.find((u) => u.username === b.username);
      if (!user || user.password !== b.password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      const { token, expiresAt } = await issueToken(user);
      return json({ token, expiresAt }, 200);
    }

    // ---- Authenticated routes ----
    const auth = req.headers.get("Authorization");

    async function authUser(): Promise<User | null> {
      if (!auth || !auth.startsWith("Bearer ")) return null;
      const tok = auth.slice(7);
      if (!tok) return null;
      return verifyToken(tok);
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const user = await authUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ username: user.username, role: user.role }, 200);
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const user = await authUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);
      const admins = users.reduce((n, u) => n + (u.role === "admin" ? 1 : 0), 0);
      return json({ users: users.length, admins }, 200);
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const user = await authUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      revokedTokens.add(auth.slice(7));
      return new Response(null, { status: 204 });
    }

    // ---- 404 ----
    return json({ error: "not_found" }, 404);
  }

  return handler;
}
