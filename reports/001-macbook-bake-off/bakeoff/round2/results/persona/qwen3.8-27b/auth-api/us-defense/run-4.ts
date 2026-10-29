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
  const revoked = new Set<string>();

  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.username, u);
  const adminCount = users.filter((u) => u.role === "admin").length;

  // Lazily import the HMAC key once, then reuse it
  let cachedKey: Promise<CryptoKey> | null = null;
  function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  // ── base64url helpers (no padding, URL-safe alphabet) ──
  function b64urlEnc(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDec(s: string): Uint8Array {
    let str = s.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4 !== 0) str += "=";
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ── response helper ──
  function jres(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── token verification ──
  async function verifyToken(
    raw: string,
  ): Promise<{ username: string; role: Role } | null> {
    if (revoked.has(raw)) return null;

    const parts = raw.split(".");
    if (parts.length !== 2) return null;

    let payloadBytes: Uint8Array;
    let sigBytes: Uint8Array;
    try {
      payloadBytes = b64urlDec(parts[0]);
      sigBytes = b64urlDec(parts[1]);
    } catch {
      return null;
    }

    const key = await getKey();
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
    if (!valid) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      return null;
    }

    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    const obj = payload as Record<string, unknown>;
    if (
      typeof obj.u !== "string" ||
      typeof obj.t !== "number" ||
      typeof obj.n !== "string"
    ) {
      return null;
    }

    // expire exactly at issuedAt + 1 h
    if (nowFn().getTime() >= obj.t + 3_600_000) return null;

    const user = userMap.get(obj.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  // ── main handler ──
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
        return jres(400, { error: "invalid_request" });
      }

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return jres(400, { error: "invalid_request" });
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return jres(400, { error: "invalid_request" });
      }

      const user = userMap.get(obj.username);
      if (!user || user.password !== obj.password) {
        return jres(401, { error: "invalid_credentials" });
      }

      const nowMs = nowFn().getTime();

      // 128-bit random nonce guarantees uniqueness even at the same instant
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);

      const payloadStr = JSON.stringify({
        u: user.username,
        t: nowMs,
        n: b64urlEnc(nonce),
      });
      const payloadBytes = new TextEncoder().encode(payloadStr);

      const key = await getKey();
      const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
      const token = b64urlEnc(payloadBytes) + "." + b64urlEnc(new Uint8Array(sigBuf));

      const expiresAt = new Date(nowMs + 3_600_000).toISOString();

      return jres(200, { token, expiresAt });
    }

    // Helper: extract & verify Bearer token from the request
    async function bearer(): Promise<{ username: string; role: Role } | null> {
      const h = req.headers.get("Authorization");
      if (!h || !h.startsWith("Bearer ")) return null;
      const tok = h.slice(7);
      if (tok.length === 0) return null;
      return verifyToken(tok);
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const user = await bearer();
      if (!user) return jres(401, { error: "unauthorized" });
      return jres(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const user = await bearer();
      if (!user) return jres(401, { error: "unauthorized" });
      if (user.role !== "admin") return jres(403, { error: "forbidden" });
      return jres(200, { users: users.length, admins: adminCount });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const h = req.headers.get("Authorization");
      if (!h || !h.startsWith("Bearer ")) {
        return jres(401, { error: "unauthorized" });
      }
      const tok = h.slice(7);
      if (tok.length === 0) {
        return jres(401, { error: "unauthorized" });
      }
      const user = await verifyToken(tok);
      if (!user) {
        return jres(401, { error: "unauthorized" });
      }
      revoked.add(tok);
      return new Response(null, { status: 204 });
    }

    // everything else
    return jres(404, { error: "not_found" });
  }

  return handler;
}
