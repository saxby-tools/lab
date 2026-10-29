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
  const activeTokens = new Set<string>();

  // Lazy key import so we don't start work outside a request
  let keyPromise: Promise<CryptoKey> | null = null;
  function getKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return keyPromise;
  }

  // --- encoding helpers (base64url, visible-ASCII, no spaces) ---
  function toB64Url(data: Uint8Array): string {
    let s = "";
    for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64Url(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // --- HMAC helpers ---
  async function sign(payload: string): Promise<string> {
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return toB64Url(new Uint8Array(sig));
  }

  async function verifyHmac(payload: string, sigB64: string): Promise<boolean> {
    const expected = await sign(payload);
    if (expected.length !== sigB64.length) return false;
    let diff = 0;
    for (let i = 0; i < sigB64.length; i++) {
      diff |= expected.charCodeAt(i) ^ sigB64.charCodeAt(i);
    }
    return diff === 0;
  }

  // --- token lifecycle ---
  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const t = now();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const payload = JSON.stringify({ u: username, i: t.getTime(), n: toB64Url(nonce) });
    const body = toB64Url(new TextEncoder().encode(payload));
    const sig = await sign(body);
    const token = `${body}.${sig}`;
    const expiresAt = new Date(t.getTime() + 3_600_000).toISOString();
    activeTokens.add(token);
    return { token, expiresAt };
  }

  async function resolveToken(
    raw: string,
  ): Promise<{ username: string; role: Role } | null> {
    // Must be in our active set (handles revocation + rejects foreign tokens)
    if (!activeTokens.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot < 1 || dot === raw.length - 1) return null;

    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);

    // Integrity – forgery / alteration / wrong-secret detection
    if (!await verifyHmac(body, sig)) return null;

    let payload: { u?: unknown; i?: unknown; n?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(fromB64Url(body)));
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.i !== "number") return null;

    // Expiry: valid on [issue, issue + 1h); expired at exactly issue + 1h
    if (now().getTime() >= payload.i + 3_600_000) return null;

    const user = users.find((u) => u.username === payload.u as string);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  // --- helpers ---
  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bearer(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (h === null || !h.startsWith("Bearer ")) return null;
    const tok = h.slice(7);
    return tok.length > 0 ? tok : null;
  }

  // --- request handler ---
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
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }
      const { username, password } = body as { username: string; password: string };
      const user = users.find((u) => u.username === username);
      // Same response whether the user is unknown or the password is wrong
      if (!user || user.password !== password) {
        return json(401, { error: "invalid_credentials" });
      }
      const { token, expiresAt } = await issueToken(username);
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const tok = bearer(req);
      if (tok === null) return json(401, { error: "unauthorized" });
      const user = await resolveToken(tok);
      if (user === null) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const tok = bearer(req);
      if (tok === null) return json(401, { error: "unauthorized" });
      const user = await resolveToken(tok);
      if (user === null) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.reduce((n, u) => n + (u.role === "admin" ? 1 : 0), 0);
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const tok = bearer(req);
      if (tok === null) return json(401, { error: "unauthorized" });
      const user = await resolveToken(tok);
      if (user === null) return json(401, { error: "unauthorized" });
      activeTokens.delete(tok);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return json(404, { error: "not_found" });
  };
}
