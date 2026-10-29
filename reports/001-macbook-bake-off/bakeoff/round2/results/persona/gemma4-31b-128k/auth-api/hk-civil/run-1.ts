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

  // In-memory state for revoked tokens
  const revokedNonces = new Set<string>();

  // Pre-compute CryptoKey for the secret to avoid repeated imports
  const encoder = new TextEncoder();
  const secretKeyData = encoder.encode(secret);

  async function getCryptoKey() {
    return await crypto.subtle.importKey(
      "raw",
      secretKeyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  async function sign(payload: string): Promise<string> {
    const key = await getCryptoKey();
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload),
    );
    // Convert signature ArrayBuffer to a hex string
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function jsonResponse(status: number, data: any) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function validateToken(authHeader: string | null): Promise<{ user: User; nonce: string } | null> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);
    if (!token) return null;

    try {
      const decoded = atob(token);
      const parts = decoded.split("|");
      if (parts.length !== 4) return null;

      const [username, expiryStr, nonce, signature] = parts;
      const payload = `${username}|${expiryStr}|${nonce}`;

      // 1. Verify Signature (Prevents forgery/alteration and ensures secret match)
      const expectedSignature = await sign(payload);
      if (signature !== expectedSignature) return null;

      // 2. Verify Expiry
      const expiry = new Date(expiryStr);
      if (now() >= expiry) return null;

      // 3. Verify Revocation
      if (revokedNonces.has(nonce)) return null;

      // 4. Identify User
      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { user, nonce };
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }

      if (
        typeof body !== "object" ||
        body === null ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      // Generate unique token
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      
      const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
      const expiryStr = expiryDate.toISOString();
      const payload = `${user.username}|${expiryStr}|${nonce}`;
      const signature = await sign(payload);
      const token = btoa(`${payload}|${signature}`);

      return jsonResponse(200, {
        token,
        expiresAt: expiryStr,
      });
    }

    // Authenticated Routes
    const authHeader = req.headers.get("Authorization");
    const auth = await validateToken(authHeader);

    if (!auth) {
      // We check routes first, then auth, but if we reach here and it's an auth route, 401.
      // Only return 401 if it's a route that REQUIRES auth.
      const authRoutes = ["/me", "/admin/stats", "/logout"];
      if (authRoutes.includes(path)) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, {
        username: auth.user.username,
        role: auth.user.role,
      });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && method === "GET") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      if (auth.user.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // POST /logout
    if (path === "/logout" && method === "POST") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      revokedNonces.add(auth.nonce);
      return new Response(null, { status: 204 });
    }

    // Not Found
    return jsonResponse(404, { error: "not_found" });
  };
}
