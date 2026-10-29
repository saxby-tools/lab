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
  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.username, u);

  const secretBytes = new TextEncoder().encode(secret);

  async function hmac(data: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  }

  function b64url(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function constantTimeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  async function issueToken(username: string, expMs: number): Promise<string> {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const payload = JSON.stringify({ u: username, e: expMs, n: b64url(nonce) });
    const pBytes = new TextEncoder().encode(payload);
    const sig = await hmac(pBytes);
    return b64url(pBytes) + "." + b64url(sig);
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const pPart = token.slice(0, dot);
    const sPart = token.slice(dot + 1);

    let pBytes: Uint8Array, sBytes: Uint8Array;
    try {
      pBytes = b64urlDecode(pPart);
      sBytes = b64urlDecode(sPart);
    } catch {
      return null;
    }

    const expected = await hmac(pBytes);
    if (!(await constantTimeEqual(expected, sBytes))) return null;

    let payload: { u?: string; e?: number; n?: string };
    try {
      payload = JSON.parse(new TextDecoder().decode(pBytes));
    } catch {
      return null;
    }

    if (typeof payload.e !== "number" || typeof payload.u !== "string") return null;

    if (now().getTime() >= payload.e) return null;

    if (revoked.has(token)) return null;

    const user = userMap.get(payload.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractBearer(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    if (t.length === 0 || t.includes(" ")) return null;
    return t;
  }

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
        return json(400, { error: "invalid_request" });
      }
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return json(400, { error: "invalid_request" });
      }
      const rec = body as Record<string, unknown>;
      if (typeof rec.username !== "string" || typeof rec.password !== "string") {
        return json(400, { error: "invalid_request" });
      }

      const user = userMap.get(rec.username);
      if (!user || user.password !== rec.password) {
        return json(401, { error: "invalid_credentials" });
      }

      const nowMs = now().getTime();
      const expMs = nowMs + 3_600_000;
      const token = await issueToken(user.username, expMs);
      const expiresAt = new Date(expMs).toISOString();

      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = extractBearer(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(token);
      if (!info) return json(401, { error: "unauthorized" });
      return json(200, { username: info.username, role: info.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = extractBearer(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(token);
      if (!info) return json(401, { error: "unauthorized" });
      if (info.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = extractBearer(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(token);
      if (!info) return json(401, { error: "unauthorized" });
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "not_found" });
  };
}
