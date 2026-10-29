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
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let keyPromise: Promise<CryptoKey> | null = null;
  function hmacKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return keyPromise;
  }

  function b64url(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): ArrayBuffer {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
  }

  async function issueToken(username: string, role: Role) {
    const t = nowFn().getTime();
    const exp = t + 3_600_000;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({
      u: username,
      r: role,
      e: exp,
      n: b64url(nonce.buffer),
    });
    const key = await hmacKey();
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const token = b64url(enc.encode(payload).buffer) + "." + b64url(sig);
    return { token, expiresAt: new Date(exp).toISOString() };
  }

  async function validateToken(
    raw: string,
  ): Promise<{ username: string; role: Role } | null> {
    if (revoked.has(raw)) return null;
    const dot = raw.indexOf(".");
    if (dot < 0 || raw.indexOf(".", dot + 1) !== -1) return null;
    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);
    let payloadBytes: ArrayBuffer;
    let sigBytes: ArrayBuffer;
    try {
      payloadBytes = b64urlDecode(payloadB64);
      sigBytes = b64urlDecode(sigB64);
    } catch {
      return null;
    }
    try {
      const key = await hmacKey();
      const ok = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
      if (!ok) return null;
      const payload = JSON.parse(dec.decode(payloadBytes)) as Record<string, unknown>;
      if (
        typeof payload.u !== "string" ||
        typeof payload.r !== "string" ||
        typeof payload.e !== "number"
      ) return null;
      if (nowFn().getTime() >= payload.e) return null;
      return { username: payload.u, role: payload.r as Role };
    } catch {
      return null;
    }
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bearerToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h) return null;
    if (!h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    if (!t) return null;
    return t;
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      let raw: string;
      try {
        raw = await req.text();
      } catch {
        return json(400, { error: "invalid_request" });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid_request" });
      }
      if (
        typeof body !== "object" || body === null || Array.isArray(body)
      ) {
        return json(400, { error: "invalid_request" });
      }
      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json(400, { error: "invalid_request" });
      }
      const user = users.find((u) => u.username === obj.username);
      if (!user || user.password !== obj.password) {
        return json(401, { error: "invalid_credentials" });
      }
      const { token, expiresAt } = await issueToken(user.username, user.role);
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = bearerToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await validateToken(token);
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = bearerToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await validateToken(token);
      if (user === null) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = bearerToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await validateToken(token);
      if (user === null) return json(401, { error: "unauthorized" });
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "not_found" });
  }

  return handler;
}
