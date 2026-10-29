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

  // In-memory state for session management
  const sessions = new Map<string, { username: string; expiresAt: number }>();

  // Pre-import the secret as a CryptoKey for HMAC
  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  /**
   * Helper to create JSON responses with the required content type.
   */
  const jsonResponse = (body: any, status = 200) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Generates a token consisting of a random nonce and an HMAC signature of that nonce.
   * Token format: base64(nonce).base64(signature)
   */
  async function generateToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const key = await keyPromise;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const signature = await crypto.subtle.sign("HMAC", key, nonce);

    const nonceB64 = btoa(String.fromCharCode(...nonce));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const token = `${nonceB64}.${sigB64}`;

    const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
    sessions.set(nonceB64, { username, expiresAt: expiryDate.getTime() });

    return { token, expiresAt: expiryDate.toISOString() };
  }

  /**
   * Validates the Bearer token and returns the associated username if successful.
   */
  async function authenticate(req: Request): Promise<string | null> {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.substring(7);
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [nonceB64, sigB64] = parts;
    const nonce = Uint8Array.from(atob(nonceB64), (c) => c.charCodeAt(0));
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

    const key = await keyPromise;
    const isValidSig = await crypto.subtle.verify("HMAC", key, sig, nonce);
    if (!isValidSig) return null;

    const session = sessions.get(nonceB64);
    if (!session) return null;

    if (now().getTime() >= session.expiresAt) {
      sessions.delete(nonceB64);
      return null;
    }

    return session.username;
  }

  return async (req: Request): Promise<Response> {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      if (
        typeof body !== "object" ||
        body === null ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      const { token, expiresAt } = await generateToken(user.username);
      return jsonResponse({ token, expiresAt });
    }

    // Authenticated routes check
    const username = await authenticate(req);
    if (username === null) {
      // Only run this check for routes that are actually authenticated
      // We'll handle the 404 case at the bottom of the handler
      if (
        (method === "GET" && (path === "/me" || path === "/admin/stats")) ||
        (method === "POST" && path === "/logout")
      ) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    const currentUser = users.find((u) => u.username === username);

    // GET /me
    if (method === "GET" && path === "/me" && currentUser) {
      return jsonResponse({ username: currentUser.username, role: currentUser.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats" && currentUser) {
      if (currentUser.role !== "admin") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // POST /logout
    if (method === "POST" && path === "/logout" && currentUser) {
      const authHeader = req.headers.get("Authorization")!;
      const token = authHeader.substring(7);
      const nonceB64 = token.split(".")[0];
      sessions.delete(nonceB64);
      return new Response(null, { status: 204 });
    }

    // Default 404
    return jsonResponse({ error: "not_found" }, 404);
  };
}
