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
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let cachedKey: CryptoKey | null = null;

  async function getKey(): Promise<CryptoKey> {
    if (!cachedKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cachedKey;
  }

  function b64url(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += String.fromCharCode(bytes[i]);
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlToBytes(s: string): Uint8Array {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function verifyAuth(
    auth: string | null,
  ): Promise<{ username: string; role: Role } | null> {
    if (!auth || !auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    if (!token || /\s/.test(token)) return null;
    if (revoked.has(token)) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;

    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    try {
      const key = await getKey();
      const sigBytes = b64urlToBytes(sigB64);
      const ok = await crypto.subtle.verify(
        "HMAC",
        key,
        sigBytes,
        enc.encode(payloadB64),
      );
      if (!ok) return null;
    } catch {
      return null;
    }

    let payload: { u?: unknown; e?: unknown };
    try {
      const raw = dec.decode(b64urlToBytes(payloadB64));
      payload = JSON.parse(raw);
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.e !== "number") {
      return null;
    }

    if (now().getTime() >= payload.e) return null;

    const user = users.find((u) => u.username === payload.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
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

      const obj = body as Record<string, unknown>;
      if (
        typeof obj.username !== "string" ||
        typeof obj.password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === obj.username);
      if (!user || user.password !== obj.password) {
        return json(401, { error: "invalid_credentials" });
      }

      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const expMs = now().getTime() + 3_600_000;
      const payloadStr = JSON.stringify({
        u: user.username,
        e: expMs,
        n: b64url(nonce),
      });
      const payloadB64 = b64url(enc.encode(payloadStr));

      const key = await getKey();
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(payloadB64),
      );
      const token = `${payloadB64}.${b64url(sig)}`;

      return json(200, {
        token,
        expiresAt: new Date(expMs).toISOString(),
      });
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      const info = await verifyAuth(req.headers.get("Authorization"));
      if (!info) return json(401, { error: "unauthorized" });
      return json(200, { username: info.username, role: info.role });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      const info = await verifyAuth(req.headers.get("Authorization"));
      if (!info) return json(401, { error: "unauthorized" });
      if (info.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (path === "/logout" && method === "POST") {
      const auth = req.headers.get("Authorization");
      const info = await verifyAuth(auth);
      if (!info) return json(401, { error: "unauthorized" });
      if (auth && auth.startsWith("Bearer ")) {
        revoked.add(auth.slice(7));
      }
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "not_found" });
  }

  return handle;
}
