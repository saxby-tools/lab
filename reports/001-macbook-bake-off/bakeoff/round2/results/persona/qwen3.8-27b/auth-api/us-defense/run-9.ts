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
  const nowFn: () => Date = options.now ?? (() => new Date());
  const revokedTokens = new Set<string>();

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.username, u);

  const keyPromise = crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function unb64url(s: string): Uint8Array {
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const bin = atob(b);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function issueToken(username: string, issuedAt: number): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({ u: username, t: issuedAt, n: b64url(nonce) });
    const payloadBytes = enc.encode(payload);
    const key = await keyPromise;
    const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
    return b64url(payloadBytes) + "." + b64url(new Uint8Array(sig));
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    if (revokedTokens.has(token)) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;
    if (token.indexOf(".", dot + 1) !== -1) return null;

    const pB64 = token.slice(0, dot);
    const sB64 = token.slice(dot + 1);

    let pBytes: Uint8Array;
    let sBytes: Uint8Array;
    try {
      pBytes = unb64url(pB64);
      sBytes = unb64url(sB64);
    } catch {
      return null;
    }

    let ok: boolean;
    try {
      ok = await crypto.subtle.verify("HMAC", await keyPromise, sBytes, pBytes);
    } catch {
      return null;
    }
    if (!ok) return null;

    let payload: { u?: unknown; t?: unknown };
    try {
      payload = JSON.parse(dec.decode(pBytes));
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.t !== "number") return null;

    const user = userMap.get(payload.u);
    if (!user) return null;

    if (nowFn().getTime() >= payload.t + 3_600_000) return null;

    return { username: user.username, role: user.role };
  }

  function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── POST /login ──────────────────────────────────────────────────────
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      if (
        typeof body !== "object" || body === null ||
        Array.isArray(body)
      ) {
        return json({ error: "invalid_request" }, 400);
      }

      const obj = body as Record<string, unknown>;
      if (
        typeof obj.username !== "string" ||
        typeof obj.password !== "string"
      ) {
        return json({ error: "invalid_request" }, 400);
      }

      const user = userMap.get(obj.username);
      if (!user || user.password !== obj.password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      const issuedAt = nowFn().getTime();
      const token = await issueToken(user.username, issuedAt);
      const expiresAt = new Date(issuedAt + 3_600_000).toISOString();

      return json({ token, expiresAt }, 200);
    }

    // ── Authenticated routes ─────────────────────────────────────────────
    const isAuthRoute =
      (method === "GET" && path === "/me") ||
      (method === "GET" && path === "/admin/stats") ||
      (method === "POST" && path === "/logout");

    if (isAuthRoute) {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return json({ error: "unauthorized" }, 401);
      }

      const token = auth.slice(7);
      const principal = await verifyToken(token);
      if (!principal) {
        return json({ error: "unauthorized" }, 401);
      }

      if (method === "GET" && path === "/me") {
        return json(
          { username: principal.username, role: principal.role },
          200,
        );
      }

      if (method === "GET" && path === "/admin/stats") {
        if (principal.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }
        let admins = 0;
        for (const u of users) if (u.role === "admin") admins++;
        return json({ users: users.length, admins }, 200);
      }

      // POST /logout
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // ── Everything else ──────────────────────────────────────────────────
    return json({ error: "not_found" }, 404);
  };
}
