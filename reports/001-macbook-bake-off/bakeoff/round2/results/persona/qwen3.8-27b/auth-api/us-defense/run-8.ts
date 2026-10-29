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
  const revoked = new Set<string>();

  // --- helpers ---

  function toBase64Url(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(s: string): Uint8Array {
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function hmacSign(data: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data),
    );
    return toBase64Url(sig);
  }

  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  async function createToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const nowMs = now().getTime();
    const exp = nowMs + 3_600_000;
    const expiresAt = new Date(exp).toISOString();

    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const nonceHex = Array.from(nonce)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const payloadJson = JSON.stringify({ u: username, exp, n: nonceHex });
    const payloadEnc = toBase64Url(new TextEncoder().encode(payloadJson).buffer);
    const sig = await hmacSign(payloadEnc);
    const token = `${payloadEnc}.${sig}`;

    return { token, expiresAt };
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    if (revoked.has(token)) return null;

    const dotIdx = token.lastIndexOf(".");
    if (dotIdx <= 0 || dotIdx === token.length - 1) return null;

    const payloadEnc = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    const expectedSig = await hmacSign(payloadEnc);
    if (!constantTimeEqual(sig, expectedSig)) return null;

    let payload: { u?: unknown; exp?: unknown; n?: unknown };
    try {
      const raw = fromBase64Url(payloadEnc);
      const text = new TextDecoder().decode(raw);
      payload = JSON.parse(text);
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.exp !== "number") return null;

    if (now().getTime() >= payload.exp) return null;

    const user = users.find((u) => u.username === payload.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function bearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (!header) return null;
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return null;
    const token = header.slice(prefix.length);
    if (token.length === 0) return null;
    return token;
  }

  // --- handler ---

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
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }

      const { username, password } = body as { username: string; password: string };

      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return json(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await createToken(username);
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = bearerToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(token);
      if (!info) return json(401, { error: "unauthorized" });
      return json(200, { username: info.username, role: info.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = bearerToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(token);
      if (!info) return json(401, { error: "unauthorized" });
      if (info.role !== "admin") return json(403, { error: "forbidden" });

      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = bearerToken(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const info = await verifyToken(token);
      if (!info) return json(401, { error: "unauthorized" });
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    // everything else
    return json(404, { error: "not_found" });
  };
}
