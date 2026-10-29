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
  const revokedJtis = new Set<string>();

  // Lazy-import the HMAC key once
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

  // --- encoding helpers ---------------------------------------------------

  function b64urlEncode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // --- token helpers ------------------------------------------------------

  async function sign(payload: string): Promise<string> {
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return b64urlEncode(new Uint8Array(sig));
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  interface TokenPayload {
    username: string;
    exp: number; // ms epoch
    jti: string; // unique id
  }

  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const exp = now().getTime() + 3_600_000;
    const rand = crypto.getRandomValues(new Uint8Array(16));
    const jti = b64urlEncode(rand);
    const payload: TokenPayload = { username, exp, jti };
    const payloadStr = JSON.stringify(payload);
    const payloadEnc = b64urlEncode(new TextEncoder().encode(payloadStr));
    const sig = await sign(payloadStr);
    return {
      token: `${payloadEnc}.${sig}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  async function verifyToken(
    raw: string,
  ): Promise<{ username: string; role: Role } | null> {
    const dot = raw.indexOf(".");
    if (dot === -1) return null;
    const payloadEnc = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);

    let payloadStr: string;
    try {
      payloadStr = new TextDecoder().decode(b64urlDecode(payloadEnc));
    } catch {
      return null;
    }

    let data: unknown;
    try {
      data = JSON.parse(payloadStr);
    } catch {
      return null;
    }
    if (
      typeof data !== "object" || data === null ||
      typeof (data as Record<string, unknown>).username !== "string" ||
      typeof (data as Record<string, unknown>).exp !== "number" ||
      typeof (data as Record<string, unknown>).jti !== "string"
    ) {
      return null;
    }

    const payload = data as TokenPayload;

    // HMAC check
    const expected = await sign(payloadStr);
    if (!constantTimeEqual(expected, sig)) return null;

    // Expiry: valid strictly before exp
    if (now().getTime() >= payload.exp) return null;

    // Revocation
    if (revokedJtis.has(payload.jti)) return null;

    // User must exist
    const user = users.find((u) => u.username === payload.username);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  // --- response helpers ---------------------------------------------------

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractBearer(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    return h.slice(7);
  }

  // --- handler ------------------------------------------------------------

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
      const { token, expiresAt } = await issueToken(user.username);
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const raw = extractBearer(req);
      if (raw === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(raw);
      if (!info) return json(401, { error: "unauthorized" });
      return json(200, { username: info.username, role: info.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const raw = extractBearer(req);
      if (raw === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(raw);
      if (!info) return json(401, { error: "unauthorized" });
      if (info.role !== "admin") return json(403, { error: "forbidden" });
      return json(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const raw = extractBearer(req);
      if (raw === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(raw);
      if (!info) return json(401, { error: "unauthorized" });
      // Token is valid – revoke its jti
      const dot = raw.indexOf(".");
      try {
        const payloadStr = new TextDecoder().decode(b64urlDecode(raw.slice(0, dot)));
        const data = JSON.parse(payloadStr) as TokenPayload;
        revokedJtis.add(data.jti);
      } catch {
        // unreachable because verifyToken already succeeded
      }
      return new Response(null, { status: 204 });
    }

    // Everything else
    return json(404, { error: "not_found" });
  };
}
