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
  const now: () => Date = options.now ?? (() => new Date());

  // ── in-memory state ────────────────────────────────────────────
  const revoked = new Set<string>();

  // ── lazy HMAC key ──────────────────────────────────────────────
  let cachedKey: CryptoKey | null = null;
  async function key(): Promise<CryptoKey> {
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

  // ── helpers ─────────────────────────────────────────────────────
  function b64url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDec(s: string): Uint8Array {
    let str = s.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sign(msg: string): Promise<string> {
    const k = await key();
    const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
    return b64url(sig);
  }

  async function verify(msg: string, sig: string): Promise<boolean> {
    try {
      const k = await key();
      return await crypto.subtle.verify(
        "HMAC",
        k,
        b64urlDec(sig),
        new TextEncoder().encode(msg),
      );
    } catch {
      return false;
    }
  }

  function j(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── token verification ──────────────────────────────────────────
  async function auth(req: Request): Promise<User | null> {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;

    const token = h.slice(7);
    if (!token || token.includes(" ")) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;

    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    if (!(await verify(payloadB64, sig))) return null;
    if (revoked.has(token)) return null;

    let p: Record<string, unknown>;
    try {
      p = JSON.parse(new TextDecoder().decode(b64urlDec(payloadB64)));
    } catch {
      return null;
    }

    if (typeof p.u !== "string" || typeof p.t !== "number") return null;
    if (now().getTime() >= p.t + 3_600_000) return null;

    return users.find((u) => u.username === p.u) ?? null;
  }

  // ── route handler ───────────────────────────────────────────────
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── POST /login ──
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return j(400, { error: "invalid_request" });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return j(400, { error: "invalid_request" });
      }
      const obj = body as Record<string, unknown>;
      const username = obj["username"];
      const password = obj["password"];
      if (typeof username !== "string" || typeof password !== "string") {
        return j(400, { error: "invalid_request" });
      }

      const user = users.find(
        (u) => u.username === username && u.password === password,
      );
      if (!user) return j(401, { error: "invalid_credentials" });

      const t = now();
      const issuedAt = t.getTime();
      const expiresAt = new Date(issuedAt + 3_600_000).toISOString();
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const payload = JSON.stringify({ u: username, t: issuedAt, n: nonce });
      const pB64 = b64url(new TextEncoder().encode(payload));
      const sig = await sign(pB64);
      const token = pB64 + "." + sig;

      return j(200, { token, expiresAt });
    }

    // ── GET /me ──
    if (method === "GET" && path === "/me") {
      const user = await auth(req);
      if (!user) return j(401, { error: "unauthorized" });
      return j(200, { username: user.username, role: user.role });
    }

    // ── GET /admin/stats ──
    if (method === "GET" && path === "/admin/stats") {
      const user = await auth(req);
      if (!user) return j(401, { error: "unauthorized" });
      if (user.role !== "admin") return j(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return j(200, { users: users.length, admins });
    }

    // ── POST /logout ──
    if (method === "POST" && path === "/logout") {
      const user = await auth(req);
      if (!user) return j(401, { error: "unauthorized" });
      const h = req.headers.get("Authorization");
      if (h && h.startsWith("Bearer ")) revoked.add(h.slice(7));
      return new Response(null, { status: 204 });
    }

    // ── everything else ──
    return j(404, { error: "not_found" });
  };
}
