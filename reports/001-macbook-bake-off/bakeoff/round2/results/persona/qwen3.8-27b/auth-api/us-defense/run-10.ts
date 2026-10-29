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

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const rem = s.length % 4;
  const padded = s + (rem === 0 ? "" : "=".repeat(4 - rem));
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function createAuthHandler(
  options: AuthOptions,
): (req: Request) => Promise<Response> {
  const { users, secret } = options;
  const now = options.now ?? (() => new Date());
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const userMap = new Map<string, User>();
  for (const u of users) userMap.set(u.username, u);
  const adminCount = users.filter((u) => u.role === "admin").length;

  const revoked = new Set<string>();

  let cachedKey: Promise<CryptoKey> | undefined;
  function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  async function issueToken(username: string): Promise<{
    token: string;
    expiresAt: string;
  }> {
    const issuedAt = now().getTime();
    const exp = issuedAt + 3_600_000;

    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);

    const payload = JSON.stringify({ u: username, exp, n: b64urlEncode(nonce) });
    const pB64 = b64urlEncode(enc.encode(payload));
    const sig = await crypto.subtle.sign("HMAC", await getKey(), enc.encode(payload));
    const sB64 = b64urlEncode(new Uint8Array(sig));

    return { token: pB64 + "." + sB64, expiresAt: new Date(exp).toISOString() };
  }

  async function verifyToken(raw: string): Promise<User | null> {
    if (revoked.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot < 1) return null;

    const pB64 = raw.slice(0, dot);
    const sB64 = raw.slice(dot + 1);
    if (!sB64) return null;

    let pBytes: Uint8Array;
    let sBytes: Uint8Array;
    try {
      pBytes = b64urlDecode(pB64);
      sBytes = b64urlDecode(sB64);
    } catch {
      return null;
    }

    const ok = await crypto.subtle.verify("HMAC", await getKey(), sBytes, pBytes);
    if (!ok) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(dec.decode(pBytes));
    } catch {
      return null;
    }

    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return null;
    }

    const p = payload as Record<string, unknown>;
    if (typeof p.u !== "string" || typeof p.exp !== "number") return null;

    if (now().getTime() >= p.exp) return null;

    const user = userMap.get(p.u);
    if (!user) return null;

    return user;
  }

  function json(data: unknown, status: number): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ── POST /login ──────────────────────────────────────────────────────
    if (path === "/login" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
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

      const { token, expiresAt } = await issueToken(user.username);
      return json({ token, expiresAt }, 200);
    }

    // ── Authenticated routes ─────────────────────────────────────────────
    if (
      (path === "/me" && method === "GET") ||
      (path === "/admin/stats" && method === "GET") ||
      (path === "/logout" && method === "POST")
    ) {
      const hdr = req.headers.get("authorization");
      if (!hdr || !hdr.startsWith("Bearer ")) {
        return json({ error: "unauthorized" }, 401);
      }

      const token = hdr.slice(7);
      if (!token) {
        return json({ error: "unauthorized" }, 401);
      }

      const user = await verifyToken(token);
      if (!user) {
        return json({ error: "unauthorized" }, 401);
      }

      if (path === "/me") {
        return json({ username: user.username, role: user.role }, 200);
      }

      if (path === "/admin/stats") {
        if (user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }
        return json({ users: users.length, admins: adminCount }, 200);
      }

      // path === "/logout"
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    // ── Everything else ──────────────────────────────────────────────────
    return json({ error: "not_found" }, 404);
  };
}
