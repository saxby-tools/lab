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
  const users = options.users;
  const secret = options.secret;
  const now = options.now ?? (() => new Date());
  const revoked = new Set<string>();
  const adminCount = users.filter((u) => u.role === "admin").length;
  const HOUR = 3_600_000;

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function b64urlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function makeToken(
    username: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const t = now().getTime();
    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(nonceBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const payload = JSON.stringify({ u: username, t, n: nonce });
    const payloadBytes = new TextEncoder().encode(payload);
    const payloadB64 = b64urlEncode(payloadBytes);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
    const sigB64 = b64urlEncode(new Uint8Array(sigBuf));

    const token = `${payloadB64}.${sigB64}`;
    const expiresAt = new Date(t + HOUR).toISOString();

    return { token, expiresAt };
  }

  async function checkToken(token: string): Promise<User | null> {
    if (revoked.has(token)) return null;

    const dot = token.indexOf(".");
    if (dot < 0) return null;

    const pB64 = token.slice(0, dot);
    const sB64 = token.slice(dot + 1);
    if (!pB64 || !sB64) return null;

    let payloadStr: string;
    try {
      payloadStr = new TextDecoder().decode(b64urlDecode(pB64));
    } catch {
      return null;
    }

    let payload: { u?: unknown; t?: unknown; n?: unknown };
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.t !== "number") {
      return null;
    }

    let sigBytes: Uint8Array;
    try {
      sigBytes = b64urlDecode(sB64);
    } catch {
      return null;
    }

    try {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "HMAC",
        key,
        sigBytes,
        new TextEncoder().encode(payloadStr),
      );
      if (!ok) return null;
    } catch {
      return null;
    }

    if (now().getTime() >= (payload.t as number) + HOUR) return null;

    return users.find((u) => u.username === (payload.u as string)) ?? null;
  }

  function getBearerToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (h === null) return null;
    const prefix = "Bearer ";
    if (!h.startsWith(prefix)) return null;
    const token = h.slice(prefix.length);
    if (token.length === 0) return null;
    return token;
  }

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      let raw: string;
      try {
        raw = await req.text();
      } catch {
        return json(400, { error: "invalid_request" });
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
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

      const user = users.find(
        (u) => u.username === obj.username && u.password === obj.password,
      );

      if (!user) {
        return json(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await makeToken(user.username);
      return json(200, { token, expiresAt });
    }

    // Authenticated routes: GET /me, GET /admin/stats, POST /logout
    const isAuthRoute =
      (method === "GET" && path === "/me") ||
      (method === "GET" && path === "/admin/stats") ||
      (method === "POST" && path === "/logout");

    if (isAuthRoute) {
      const token = getBearerToken(req);
      if (token === null) {
        return json(401, { error: "unauthorized" });
      }

      const user = await checkToken(token);
      if (user === null) {
        return json(401, { error: "unauthorized" });
      }

      if (method === "GET" && path === "/me") {
        return json(200, { username: user.username, role: user.role });
      }

      if (method === "GET" && path === "/admin/stats") {
        if (user.role !== "admin") {
          return json(403, { error: "forbidden" });
        }
        return json(200, { users: users.length, admins: adminCount });
      }

      // POST /logout
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "not_found" });
  };
}
