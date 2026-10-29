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
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let cachedKey: CryptoKey | null = null;
  function getKey(): Promise<CryptoKey> {
    if (cachedKey === null) {
      cachedKey = crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    return cachedKey;
  }

  function toB64url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += String.fromCharCode(bytes[i]);
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(s: string): Uint8Array {
    let str = s.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4 !== 0) str += "=";
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ctEq(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function handleLogin(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
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

    const now = nowFn();
    const exp = now.getTime() + 3_600_000;
    const nonce = toB64url(crypto.getRandomValues(new Uint8Array(16)));
    const payloadJson = JSON.stringify({ u: user.username, e: exp, n: nonce });
    const payloadB64 = toB64url(enc.encode(payloadJson));
    const key = await getKey();
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
    const sigB64 = toB64url(sig);
    const token = payloadB64 + "." + sigB64;
    const expiresAt = new Date(exp).toISOString();

    return json(200, { token, expiresAt });
  }

  async function verifyToken(raw: string): Promise<User | null> {
    if (revoked.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot < 1) return null;
    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);
    if (!payloadB64 || !sigB64) return null;

    const key = await getKey();
    const expectedSig = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(payloadB64),
    );
    if (!ctEq(toB64url(expectedSig), sigB64)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(dec.decode(fromB64url(payloadB64)));
    } catch {
      return null;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as Record<string, unknown>).u !== "string" ||
      typeof (payload as Record<string, unknown>).e !== "number"
    ) {
      return null;
    }
    const p = payload as { u: string; e: number };
    if (nowFn().getTime() >= p.e) return null;
    const user = users.find((u) => u.username === p.u);
    if (!user) return null;
    return user;
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "POST" && path === "/login") {
      return handleLogin(req);
    }

    if (
      (method === "GET" && path === "/me") ||
      (method === "GET" && path === "/admin/stats") ||
      (method === "POST" && path === "/logout")
    ) {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return json(401, { error: "unauthorized" });
      }
      const token = auth.slice(7);
      if (!token) {
        return json(401, { error: "unauthorized" });
      }
      const user = await verifyToken(token);
      if (!user) {
        return json(401, { error: "unauthorized" });
      }

      if (path === "/me") {
        return json(200, { username: user.username, role: user.role });
      }

      if (path === "/admin/stats") {
        if (user.role !== "admin") {
          return json(403, { error: "forbidden" });
        }
        const admins = users.filter((u) => u.role === "admin").length;
        return json(200, { users: users.length, admins });
      }

      // path === "/logout"
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "not_found" });
  };
}
