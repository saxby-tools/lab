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
  const nowFn = options.now ?? (() => new Date());
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();

  function toBase64Url(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(str: string): Uint8Array {
    let binary = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
    const pad = (4 - (binary.length % 4)) % 4;
    binary += "=".repeat(pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function sign(message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return toBase64Url(sig);
  }

  function constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    if (revokedTokens.has(token)) return null;

    const dotIdx = token.indexOf(".");
    if (dotIdx < 1 || dotIdx === token.length - 1) return null;

    const payloadB64 = token.slice(0, dotIdx);
    const sigB64 = token.slice(dotIdx + 1);

    const expectedSig = await sign(payloadB64);
    if (!constantTimeCompare(expectedSig, sigB64)) return null;

    let payload: string;
    try {
      payload = new TextDecoder().decode(fromBase64Url(payloadB64));
    } catch {
      return null;
    }

    let data: { u?: unknown; e?: unknown; n?: unknown };
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }

    if (typeof data.u !== "string" || typeof data.e !== "number") return null;

    const nowMs = nowFn().getTime();
    if (nowMs >= data.e) return null;

    const user = users.find((u) => u.username === data.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractBearer(req: Request): string | null {
    const auth = req.headers.get("Authorization");
    if (!auth) return null;
    const match = /^Bearer (.+)$/.exec(auth);
    if (!match) return null;
    return match[1];
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
        return json({ error: "invalid_request" }, 400);
      }

      if (
        typeof body !== "object" || body === null || Array.isArray(body)
      ) {
        return json({ error: "invalid_request" }, 400);
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json({ error: "invalid_request" }, 400);
      }

      const user = users.find((u) => u.username === obj.username);
      if (!user || user.password !== obj.password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      const expiry = new Date(nowFn().getTime() + 3_600_000);
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const payload = JSON.stringify({
        u: user.username,
        e: expiry.getTime(),
        n: toBase64Url(nonce),
      });
      const payloadB64 = toBase64Url(encoder.encode(payload));
      const sig = await sign(payloadB64);
      const token = `${payloadB64}.${sig}`;

      return json({ token, expiresAt: expiry.toISOString() });
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      const token = extractBearer(req);
      if (!token) return json({ error: "unauthorized" }, 401);

      const result = await verifyToken(token);
      if (!result) return json({ error: "unauthorized" }, 401);

      return json({ username: result.username, role: result.role });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      const token = extractBearer(req);
      if (!token) return json({ error: "unauthorized" }, 401);

      const result = await verifyToken(token);
      if (!result) return json({ error: "unauthorized" }, 401);

      if (result.role !== "admin") {
        return json({ error: "forbidden" }, 403);
      }

      const admins = users.filter((u) => u.role === "admin").length;
      return json({ users: users.length, admins });
    }

    // POST /logout
    if (path === "/logout" && method === "POST") {
      const token = extractBearer(req);
      if (!token) return json({ error: "unauthorized" }, 401);

      const result = await verifyToken(token);
      if (!result) return json({ error: "unauthorized" }, 401);

      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return json({ error: "not_found" }, 404);
  };
}
