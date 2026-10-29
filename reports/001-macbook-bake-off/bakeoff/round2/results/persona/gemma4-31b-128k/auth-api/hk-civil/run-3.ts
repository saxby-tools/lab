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

  // In-memory session store: token -> session data
  const sessions = new Map<string, { username: string; role: Role; expiresAt: number }>();

  // Cache the CryptoKey to avoid re-importing on every request
  let cryptoKey: CryptoKey | null = null;
  const encoder = new TextEncoder();

  async function getSecretKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return cryptoKey;
  }

  function jsonResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost"); // Base needed to parse pathname
    const path = url.pathname;
    const method = req.method;

    // Helper to extract and validate token
    async function authenticate(): Promise<{ username: string; role: Role } | null> {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
      }

      const token = authHeader.slice(7);
      const session = sessions.get(token);

      if (!session) return null;

      // Check expiry: valid until exactly one hour after issuance.
      // At that instant and after, it is expired.
      if (now().getTime() >= session.expiresAt) {
        sessions.delete(token);
        return null;
      }

      return { username: session.username, role: session.role };
    }

    // --- Route: POST /login ---
    if (method === "POST" && path === "/login") {
      let body: any;
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
        // Uniform error to avoid revealing if username exists
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      // Token generation
      // To ensure tokens cannot be forged or guessed and are bound to the secret,
      // we use a random nonce signed with HMAC-SHA256.
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const key = await getSecretKey();
      const signature = await crypto.subtle.sign("HMAC", key, nonce);
      
      // Convert signature to a visible ASCII string (base64)
      const token = btoa(String.fromCharCode(...new Uint8Array(signature)));
      
      const expiresAtDate = new Date(now().getTime() + 3600000);
      const expiresAtTs = expiresAtDate.getTime();

      sessions.set(token, {
        username: user.username,
        role: user.role,
        expiresAt: expiresAtTs,
      });

      return jsonResponse(200, {
        token,
        expiresAt: expiresAtDate.toISOString(),
      });
    }

    // --- Authenticated Routes ---
    const auth = await authenticate();
    if (!auth) {
      // If we reached here, it's either a route that requires auth or an invalid token.
      // We must distinguish between "not found" and "unauthorized".
      if (
        (method === "GET" && (path === "/me" || path === "/admin/stats")) ||
        (method === "POST" && path === "/logout")
      ) {
        return jsonResponse(401, { error: "unauthorized" });
      }
      // Fall through to 404 for other paths
    }

    if (method === "GET" && path === "/me" && auth) {
      return jsonResponse(200, { username: auth.username, role: auth.role });
    }

    if (method === "GET" && path === "/admin/stats" && auth) {
      if (auth.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      const adminCount = users.filter((u) => u.role === "admin").length;
      return jsonResponse(200, {
        users: users.length,
        admins: adminCount,
      });
    }

    if (method === "POST" && path === "/logout" && auth) {
      const authHeader = req.headers.get("Authorization")!;
      const token = authHeader.slice(7);
      sessions.delete(token);
      return new Response(null, { status: 204 });
    }

    // --- Everything else ---
    return jsonResponse(404, { error: "not_found" });
  };
}
