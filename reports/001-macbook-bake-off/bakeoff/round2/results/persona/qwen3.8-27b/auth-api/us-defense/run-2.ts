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
  const totalUsers = users.length;
  const adminCount = users.filter((u) => u.role === "admin").length;

  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  function toBase64Url(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(s: string): Uint8Array {
    let padded = s.replace(/-/g, "+").replace(/_/g, "/");
    padded += "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function sign(payloadB64: string): Promise<string> {
    const key = await keyPromise;
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payloadB64),
    );
    return toBase64Url(new Uint8Array(sig));
  }

  async function createToken(username: string, iat: number): Promise<string> {
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const jti = toBase64Url(nonce);
    const payload = JSON.stringify({ sub: username, iat, jti });
    const payloadB64 = toBase64Url(new TextEncoder().encode(payload));
    const sig = await sign(payloadB64);
    return `${payloadB64}.${sig}`;
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    if (revoked.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;
    if (payloadB64.length === 0 || sigB64.length === 0) return null;

    const expectedSig = await sign(payloadB64);
    if (!constantTimeEqual(sigB64, expectedSig)) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    } catch {
      return null;
    }

    if (
      typeof payload.sub !== "string" ||
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat)
    ) {
      return null;
    }

    const exp = payload.iat + 3_600_000;
    if (now().getTime() >= exp) return null;

    const user = userMap.get(payload.sub);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function getBearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (!header) return null;
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    if (token.length === 0) return null;
    return token;
  }

  return async (req: Request): Promise<Response> => {
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

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json(400, { error: "invalid_request" });
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json(400, { error: "invalid_request" });
      }

      const user = userMap.get(obj.username);
      if (!user || user.password !== obj.password) {
        return json(401, { error: "invalid_credentials" });
      }

      const iat = now().getTime();
      const token = await createToken(user.username, iat);
      const expiresAt = new Date(iat + 3_600_000).toISOString();

      return json(200, { token, expiresAt });
    }

    // Authenticated routes
    if (
      (path === "/me" && method === "GET") ||
      (path === "/admin/stats" && method === "GET") ||
      (path === "/logout" && method === "POST")
    ) {
      const token = getBearerToken(req);
      if (token === null) {
        return json(401, { error: "unauthorized" });
      }

      const auth = await verifyToken(token);
      if (auth === null) {
        return json(401, { error: "unauthorized" });
      }

      if (path === "/me") {
        return json(200, { username: auth.username, role: auth.role });
      }

      if (path === "/admin/stats") {
        if (auth.role !== "admin") {
          return json(403, { error: "forbidden" });
        }
        return json(200, { users: totalUsers, admins: adminCount });
      }

      // POST /logout
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "not_found" });
  };
}
