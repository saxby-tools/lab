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
  const HOUR_MS = 3_600_000;

  // --- helpers ---

  function base64urlEncode(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlDecode(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function computeHmac(data: string): Promise<string> {
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
    return base64urlEncode(new Uint8Array(sig));
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
    u: string;
    r: Role;
    e: number;
    n: string;
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;

    // Verify HMAC – rejects forged / altered / wrong-secret tokens
    const expectedSig = await computeHmac(payloadB64);
    if (!constantTimeEqual(expectedSig, sigB64)) return null;

    // Decode and parse payload
    let payload: TokenPayload;
    try {
      const bytes = base64urlDecode(payloadB64);
      payload = JSON.parse(new TextDecoder().decode(bytes)) as TokenPayload;
    } catch {
      return null;
    }

    if (
      typeof payload.u !== "string" ||
      typeof payload.r !== "string" ||
      typeof payload.e !== "number" ||
      (payload.r !== "admin" && payload.r !== "member")
    ) {
      return null;
    }

    // Expiry – at exactly one hour the token is expired
    if (nowFn().getTime() >= payload.e) return null;

    // Revocation
    if (revokedTokens.has(token)) return null;

    // The user must still exist in the fixed list
    const user = users.find((u) => u.username === payload.u);
    if (!user) return null;

    return { username: payload.u, role: payload.r };
  }

  // --- handler ---

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ---- POST /login ----
    if (path === "/login" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "invalid_request" }, 400);
      }

      const obj = body as Record<string, unknown>;
      const username = obj["username"];
      const password = obj["password"];

      if (typeof username !== "string" || typeof password !== "string") {
        return json({ error: "invalid_request" }, 400);
      }

      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      // Build a unique token every time (nonce guarantees uniqueness)
      const nowMs = nowFn().getTime();
      const exp = nowMs + HOUR_MS;
      const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

      const payloadJson = JSON.stringify({
        u: user.username,
        r: user.role,
        e: exp,
        n: nonce,
      });
      const payloadB64 = base64urlEncode(new TextEncoder().encode(payloadJson));
      const sig = await computeHmac(payloadB64);
      const token = `${payloadB64}.${sig}`;

      const expiresAt = new Date(exp).toISOString();
      return json({ token, expiresAt });
    }

    // ---- helpers for authenticated routes ----
    async function authed(): Promise<
      { username: string; role: Role } | null
    > {
      const header = req.headers.get("Authorization");
      if (!header || !header.startsWith("Bearer ")) return null;
      const token = header.slice(7);
      if (token.length === 0) return null;
      return verifyToken(token);
    }

    // ---- GET /me ----
    if (path === "/me" && method === "GET") {
      const user = await authed();
      if (!user) return json({ error: "unauthorized" }, 401);
      return json({ username: user.username, role: user.role });
    }

    // ---- GET /admin/stats ----
    if (path === "/admin/stats" && method === "GET") {
      const user = await authed();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (user.role !== "admin") {
        return json({ error: "forbidden" }, 403);
      }
      const adminCount = users.filter((u) => u.role === "admin").length;
      return json({ users: users.length, admins: adminCount });
    }

    // ---- POST /logout ----
    if (path === "/logout" && method === "POST") {
      const header = req.headers.get("Authorization");
      if (!header || !header.startsWith("Bearer ")) {
        return json({ error: "unauthorized" }, 401);
      }
      const token = header.slice(7);
      if (token.length === 0) {
        return json({ error: "unauthorized" }, 401);
      }
      const user = await verifyToken(token);
      if (!user) return json({ error: "unauthorized" }, 401);
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // ---- everything else ----
    return json({ error: "not_found" }, 404);
  };
}
