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
  const { users, secret, now = () => new Date() } = options;

  const revokedTokens = new Set<string>();

  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.username, u);

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

  function b64url(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlToBytes(s: string): Uint8Array | null {
    try {
      let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function createToken(username: string): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const key = await getKey();
    const expiresAt = new Date(now().getTime() + 3_600_000);
    const nonce = crypto.getRandomValues(new Uint8Array(16));

    const payload = JSON.stringify({
      u: username,
      e: expiresAt.toISOString(),
      n: b64url(nonce),
    });
    const payloadEnc = b64url(new TextEncoder().encode(payload));

    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payloadEnc),
    );

    const token = `${payloadEnc}.${b64url(new Uint8Array(sig))}`;
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    const parts = raw.split(".");
    if (parts.length !== 2) return null;

    const [payloadEnc, sigEnc] = parts;

    const sigBytes = b64urlToBytes(sigEnc);
    if (!sigBytes) return null;

    const key = await getKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(payloadEnc),
    );
    if (!valid) return null;

    const decoded = b64urlToBytes(payloadEnc);
    if (!decoded) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(decoded));
    } catch {
      return null;
    }

    if (typeof payload !== "object" || payload === null) return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.u !== "string" || typeof obj.e !== "string") return null;

    const exp = new Date(obj.e);
    if (Number.isNaN(exp.getTime())) return null;
    if (now() >= exp) return null;

    if (revokedTokens.has(raw)) return null;

    const user = userMap.get(obj.u);
    if (!user) return null;

    return user;
  }

  function json(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function getBearer(req: Request): Promise<string | null> {
    const hdr = req.headers.get("Authorization");
    if (!hdr || !hdr.startsWith("Bearer ")) return null;
    return hdr.slice(7);
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json({ error: "invalid_request" }, 400);
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json({ error: "invalid_request" }, 400);
      }

      const user = userMap.get(obj.username);
      if (!user || user.password !== obj.password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      const { token, expiresAt } = await createToken(obj.username);
      return json({ token, expiresAt });
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      const raw = await getBearer(req);
      if (!raw) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(raw);
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      const raw = await getBearer(req);
      if (!raw) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(raw);
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") return json({ error: "forbidden" }, 403);

      let admins = 0;
      for (const u of users) if (u.role === "admin") admins++;
      return json({ users: users.length, admins });
    }

    // POST /logout
    if (path === "/logout" && method === "POST") {
      const raw = await getBearer(req);
      if (!raw) return json({ error: "unauthorized" }, 401);
      const user = await verifyToken(raw);
      if (!user) return json({ error: "unauthorized" }, 401);
      revokedTokens.add(raw);
      return new Response(null, { status: 204 });
    }

    return json({ error: "not_found" }, 404);
  }

  return handler;
}
