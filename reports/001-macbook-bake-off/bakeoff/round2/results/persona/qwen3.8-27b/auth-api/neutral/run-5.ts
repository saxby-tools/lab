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
  const now = options.now ?? (() => new Date());
  const users = options.users;
  const secret = options.secret;

  const revokedTokens = new Set<string>();
  const HOUR_MS = 3_600_000;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function base64urlEncode(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  function base64urlDecode(str: string): Uint8Array {
    const padLen = (4 - (str.length % 4)) % 4;
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function importKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  async function createToken(username: string): Promise<{ token: string; exp: number }> {
    const exp = now().getTime() + HOUR_MS;
    const jti = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const payload = { u: username, e: exp, j: jti };
    const payloadJson = JSON.stringify(payload);
    const payloadEncoded = base64urlEncode(encoder.encode(payloadJson));

    const key = await importKey();
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadEncoded),
    );
    const sigEncoded = base64urlEncode(new Uint8Array(sig));

    const token = `${payloadEncoded}.${sigEncoded}`;
    return { token, exp };
  }

  async function verifyToken(raw: string): Promise<{ username: string; role: Role } | null> {
    if (revokedTokens.has(raw)) return null;

    const dotIndex = raw.indexOf(".");
    if (dotIndex < 0) return null;
    const payloadEncoded = raw.slice(0, dotIndex);
    const sigEncoded = raw.slice(dotIndex + 1);
    if (payloadEncoded === "" || sigEncoded === "") return null;

    let sigBytes: Uint8Array;
    try {
      sigBytes = base64urlDecode(sigEncoded);
    } catch {
      return null;
    }

    const key = await importKey();
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      encoder.encode(payloadEncoded),
    );
    if (!isValid) return null;

    let payloadBytes: Uint8Array;
    try {
      payloadBytes = base64urlDecode(payloadEncoded);
    } catch {
      return null;
    }

    let payload: { u: string; e: number; j: string };
    try {
      payload = JSON.parse(decoder.decode(payloadBytes));
    } catch {
      return null;
    }

    if (typeof payload.u !== "string" || typeof payload.e !== "number") return null;

    if (now().getTime() >= payload.e) return null;

    const user = users.find((u) => u.username === payload.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractBearer(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (!header) return null;
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    if (token === "") return null;
    return token;
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
        return json({ error: "invalid_request" }, 400);
      }

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return json({ error: "invalid_request" }, 400);
      }

      const { username, password } = body as { username: string; password: string };

      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      const { token, exp } = await createToken(username);
      const expiresAt = new Date(exp).toISOString();

      return json({ token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const token = extractBearer(req);
      if (token === null) {
        return json({ error: "unauthorized" }, 401);
      }
      const user = await verifyToken(token);
      if (!user) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const token = extractBearer(req);
      if (token === null) {
        return json({ error: "unauthorized" }, 401);
      }
      const user = await verifyToken(token);
      if (!user) {
        return json({ error: "unauthorized" }, 401);
      }
      if (user.role !== "admin") {
        return json({ error: "forbidden" }, 403);
      }
      const adminCount = users.filter((u) => u.role === "admin").length;
      return json({ users: users.length, admins: adminCount });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const token = extractBearer(req);
      if (token === null) {
        return json({ error: "unauthorized" }, 401);
      }
      const user = await verifyToken(token);
      if (!user) {
        return json({ error: "unauthorized" }, 401);
      }
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return json({ error: "not_found" }, 404);
  };
}
