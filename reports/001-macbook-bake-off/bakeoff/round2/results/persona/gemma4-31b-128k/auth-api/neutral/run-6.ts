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
  const { users, secret, now = () => new Date() } = options;
  const revokedTokens = new Set<string>();

  // Pre-import the secret as a CryptoKey to avoid doing it on every request.
  // Since createAuthHandler is synchronous, we store the promise.
  const keyPromise = (async () => {
    const enc = new TextEncoder();
    return await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  })();

  async function sign(data: string): Promise<string> {
    const key = await keyPromise;
    const enc = new TextEncoder();
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function jsonResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    try {
      if (revokedTokens.has(token)) return null;

      const decoded = atob(token);
      const parts = decoded.split("|");
      if (parts.length !== 4) return null;

      const [username, expiryStr, nonce, signature] = parts;
      const expiry = parseInt(expiryStr, 10);

      // Validate signature
      const payload = `${username}|${expiryStr}|${nonce}`;
      const expectedSignature = await sign(payload);
      if (signature !== expectedSignature) return null;

      // Validate expiry
      if (now().getTime() >= expiry) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Route: POST /login
    if (path === "/login" && method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }

      if (!body || typeof body !== "object" || typeof body.username !== "string" || typeof body.password !== "string") {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username);
      // Constant time check not explicitly required, but simple check for creds
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiryDate = new Date(now().getTime() + 3600000);
      const expiryTimestamp = expiryDate.getTime().toString();
      const nonce = crypto.randomUUID();
      const payload = `${user.username}|${expiryTimestamp}|${nonce}`;
      const signature = await sign(payload);
      const token = btoa(`${payload}|${signature}`);

      return jsonResponse(200, {
        token,
        expiresAt: expiryDate.toISOString(),
      });
    }

    // Authenticated Routes Middleware
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // If not the login route and no auth header, it might be a 404 or 401.
      // However, we only check auth for specific paths.
    }

    const token = authHeader?.split(" ")[1];
    const authUser = token ? await verifyToken(token) : null;

    // Route: GET /me
    if (path === "/me" && method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    // Route: GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      if (authUser.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // Route: POST /logout
    if (path === "/logout" && method === "POST") {
      if (!token || !authUser) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return jsonResponse(404, { error: "not_found" });
  };
}
