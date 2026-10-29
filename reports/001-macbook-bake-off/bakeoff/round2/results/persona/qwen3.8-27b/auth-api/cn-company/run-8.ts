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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let cachedKey: CryptoKey | null = null;

  async function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return cachedKey;
  }

  function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const issued = nowFn().getTime();
    const expiresAt = new Date(issued + 3_600_000).toISOString();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({ u: username, i: issued, n: toBase64Url(nonce) });
    const payloadB64 = toBase64Url(encoder.encode(payload));
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    const sigB64 = toBase64Url(new Uint8Array(sig));
    return { token: payloadB64 + "." + sigB64, expiresAt };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    if (revoked.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot <= 0 || dot === raw.length - 1) return null;

    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    const key = await getKey();
    const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    const expectedB64 = toBase64Url(new Uint8Array(expected));

    if (sigB64.length !== expectedB64.length) return null;
    let diff = 0;
    for (let i = 0; i < sigB64.length; i++) {
      diff |= sigB64.charCodeAt(i) ^ expectedB64.charCodeAt(i);
    }
    if (diff !== 0) return null;

    let payload: { u?: unknown; i?: unknown; n?: unknown };
    try {
      payload = JSON.parse(decoder.decode(fromBase64Url(payloadB64)));
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.i !== "number") return null;

    if (nowFn().getTime() >= payload.i + 3_600_000) return null;

    return users.find((u) => u.username === payload.u) ?? null;
  }

  function jsonResp(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    return t.length > 0 ? t : null;
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResp(400, { error: "invalid_request" });
      }

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return jsonResp(400, { error: "invalid_request" });
      }

      const { username, password } = body as { username: string; password: string };
      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return jsonResp(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await issueToken(username);
      return jsonResp(200, { token, expiresAt });
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      const token = extractToken(req);
      if (!token) return jsonResp(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return jsonResp(401, { error: "unauthorized" });
      return jsonResp(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      const token = extractToken(req);
      if (!token) return jsonResp(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return jsonResp(401, { error: "unauthorized" });
      if (user.role !== "admin") return jsonResp(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return jsonResp(200, { users: users.length, admins });
    }

    // POST /logout
    if (path === "/logout" && method === "POST") {
      const token = extractToken(req);
      if (!token) return jsonResp(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return jsonResp(401, { error: "unauthorized" });
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResp(404, { error: "not_found" });
  };
}
