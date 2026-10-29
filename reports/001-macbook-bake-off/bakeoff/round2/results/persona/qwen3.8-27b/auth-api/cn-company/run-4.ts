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

  const revokedJtis = new Set<string>();

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function base64urlEncode(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlDecode(s: string): string {
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    let out = "";
    for (let i = 0; i < binary.length; i++) {
      out += String.fromCharCode(binary.charCodeAt(i));
    }
    return out;
  }

  async function hmacSign(data: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    return base64urlEncode(sig);
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function issueToken(username: string): Promise<{ token: string; expMs: number }> {
    const nowMs = nowFn().getTime();
    const expMs = nowMs + 3_600_000;
    const jtiBytes = crypto.getRandomValues(new Uint8Array(16));
    const jti = base64urlEncode(jtiBytes.buffer);

    const payloadObj = { u: username, e: expMs, j: jti };
    const payloadJson = JSON.stringify(payloadObj);
    const payloadB64 = base64urlEncode(encoder.encode(payloadJson).buffer);
    const sig = await hmacSign(payloadB64);
    const token = payloadB64 + "." + sig;

    return { token, expMs };
  }

  async function verifyToken(
    tokenStr: string,
  ): Promise<{ username: string; role: Role; jti: string } | null> {
    const dotIdx = tokenStr.indexOf(".");
    if (dotIdx < 0) return null;

    const payloadB64 = tokenStr.slice(0, dotIdx);
    const sigB64 = tokenStr.slice(dotIdx + 1);
    if (payloadB64.length === 0 || sigB64.length === 0) return null;

    const expectedSig = await hmacSign(payloadB64);
    if (!constantTimeEqual(sigB64, expectedSig)) return null;

    let payloadJson: string;
    try {
      payloadJson = base64urlDecode(payloadB64);
    } catch {
      return null;
    }

    let data: unknown;
    try {
      data = JSON.parse(payloadJson);
    } catch {
      return null;
    }

    if (typeof data !== "object" || data === null) return null;
    const obj = data as Record<string, unknown>;
    if (
      typeof obj.u !== "string" ||
      typeof obj.e !== "number" ||
      typeof obj.j !== "string"
    ) {
      return null;
    }

    const jti = obj.j;
    if (revokedJtis.has(jti)) return null;

    const nowMs = nowFn().getTime();
    if (nowMs >= obj.e) return null;

    const user = users.find((u) => u.username === obj.u);
    if (!user) return null;

    return { username: user.username, role: user.role, jti };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

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
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body)
      ) {
        return json(400, { error: "invalid_request" });
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json(400, { error: "invalid_request" });
      }

      const { username, password } = obj;
      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return json(401, { error: "invalid_credentials" });
      }

      const { token, expMs } = await issueToken(username);
      const expiresAt = new Date(expMs).toISOString();
      return json(200, { token, expiresAt });
    }

    // Authenticated routes – extract bearer token
    let bearer: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== null && authHeader.startsWith("Bearer ")) {
      bearer = authHeader.slice(7);
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      if (bearer === null || bearer.length === 0) {
        return json(401, { error: "unauthorized" });
      }
      const verified = await verifyToken(bearer);
      if (!verified) {
        return json(401, { error: "unauthorized" });
      }
      return json(200, { username: verified.username, role: verified.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      if (bearer === null || bearer.length === 0) {
        return json(401, { error: "unauthorized" });
      }
      const verified = await verifyToken(bearer);
      if (!verified) {
        return json(401, { error: "unauthorized" });
      }
      if (verified.role !== "admin") {
        return json(403, { error: "forbidden" });
      }
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      if (bearer === null || bearer.length === 0) {
        return json(401, { error: "unauthorized" });
      }
      const verified = await verifyToken(bearer);
      if (!verified) {
        return json(401, { error: "unauthorized" });
      }
      revokedJtis.add(verified.jti);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return json(404, { error: "not_found" });
  };
}
