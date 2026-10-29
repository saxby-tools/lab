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
  const revoked = new Set<string>();
  const now: () => Date = options.now ?? (() => new Date());
  const { users, secret } = options;

  // ── base64url helpers ──────────────────────────────────────────
  function b64urlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4 !== 0) s += "=";
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  // ── HMAC-SHA256 ────────────────────────────────────────────────
  async function sign(data: string): Promise<Uint8Array> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    return new Uint8Array(sig);
  }

  // ── token creation / validation ────────────────────────────────
  async function issueToken(user: User): Promise<{ token: string; expMs: number }> {
    const expMs = now().getTime() + 3_600_000;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payloadStr = JSON.stringify({
      u: user.username,
      e: expMs,
      n: b64urlEncode(nonce),
    });
    const sig = await sign(payloadStr);
    const token = b64urlEncode(new TextEncoder().encode(payloadStr)) + "." + b64urlEncode(sig);
    return { token, expMs };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    // must be exactly two dot-separated segments
    const dot = raw.indexOf(".");
    if (dot < 1 || raw.indexOf(".", dot + 1) !== -1) return null;

    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    let payloadBytes: Uint8Array;
    try {
      payloadBytes = b64urlDecode(payloadB64);
    } catch {
      return null;
    }
    const payloadStr = new TextDecoder().decode(payloadBytes);

    // verify HMAC
    let expected: Uint8Array;
    try {
      expected = await sign(payloadStr);
    } catch {
      return null;
    }
    let actual: Uint8Array;
    try {
      actual = b64urlDecode(sigB64);
    } catch {
      return null;
    }
    if (expected.length !== actual.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    if (diff !== 0) return null;

    // revocation
    if (revoked.has(raw)) return null;

    // parse payload
    let payload: unknown;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return null;
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) return null;
    const p = payload as Record<string, unknown>;
    if (typeof p.u !== "string" || typeof p.e !== "number") return null;

    // expiration: valid strictly before expMs
    if (now().getTime() >= p.e) return null;

    // resolve user
    const user = users.find((u) => u.username === p.u);
    if (!user) return null;

    return user;
  }

  // ── extract & validate Bearer token from a header value ────────
  async function authUser(header: string | null): Promise<User | null> {
    if (!header) return null;
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    if (token.length === 0) return null;
    return verifyToken(token);
  }

  // ── response helpers ────────────────────────────────────────────
  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── handler ─────────────────────────────────────────────────────
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
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json(400, { error: "invalid_request" });
      }
      const fields = body as Record<string, unknown>;
      if (typeof fields.username !== "string" || typeof fields.password !== "string") {
        return json(400, { error: "invalid_request" });
      }
      const user = users.find(
        (u) => u.username === fields.username && u.password === fields.password,
      );
      if (!user) return json(401, { error: "invalid_credentials" });

      const { token, expMs } = await issueToken(user);
      return json(200, { token, expiresAt: new Date(expMs).toISOString() });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const user = await authUser(req.headers.get("Authorization"));
      if (!user) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const user = await authUser(req.headers.get("Authorization"));
      if (!user) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const header = req.headers.get("Authorization");
      if (!header || !header.startsWith("Bearer ")) {
        return json(401, { error: "unauthorized" });
      }
      const token = header.slice(7);
      if (token.length === 0) return json(401, { error: "unauthorized" });

      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });

      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    // everything else
    return json(404, { error: "not_found" });
  };
}
