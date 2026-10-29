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
  const encoder = new TextEncoder();

  // Pre-import the secret key for HMAC operations
  const secretKeyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const sign = async (data: string): Promise<string> => {
    const key = await secretKeyPromise;
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  };

  const verify = async (token: string): Promise<{ username: string; role: Role } | null> => {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    if (revokedTokens.has(token)) return null;

    try {
      const payload = atob(payloadB64);
      const expectedSignature = await sign(payload);
      if (signatureB64 !== expectedSignature) return null;

      const [username, expiryStr, nonce] = payload.split(":");
      const expiry = parseInt(expiryStr, 10);

      if (isNaN(expiry) || now().getTime() >= expiry) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
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
      // Constant-time check not strictly required by prompt, but avoiding 
      // revealing existence is. We use the same 401 for both failures.
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
      const expiryTimestamp = expiryDate.getTime();
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const payload = `${user.username}:${expiryTimestamp}:${nonce}`;
      const payloadB64 = btoa(payload);
      const signatureB64 = await sign(payload);
      const token = `${payloadB64}.${signatureB64}`;

      return jsonResponse(200, {
        token,
        expiresAt: expiryDate.toISOString(),
      });
    }

    // Authenticated routes middleware logic
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const authUser = await verify(token);

      if (authUser) {
        // GET /me
        if (path === "/me" && method === "GET") {
          return jsonResponse(200, {
            username: authUser.username,
            role: authUser.role,
          });
        }

        // GET /admin/stats
        if (path === "/admin/stats" && method === "GET") {
          if (authUser.role !== "admin") {
            return jsonResponse(403, { error: "forbidden" });
          }
          return jsonResponse(200, {
            users: users.length,
            admins: users.filter((u) => u.role === "admin").length,
          });
        }

        // POST /logout
        if (path === "/logout" && method === "POST") {
          revokedTokens.add(token);
          return new Response(null, { status: 204 });
        }
      } else {
        // If the token was provided but is invalid, expired, or revoked
        // We only return 401 for paths that REQUIRE authentication.
        // The logic below handles the "fallback" for non-matching routes.
      }
    }

    // Handle unauthorized access to authenticated routes
    if (
      (path === "/me" && method === "GET") ||
      (path === "/admin/stats" && method === "GET") ||
      (path === "/logout" && method === "POST")
    ) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    // Everything else
    return jsonResponse(404, { error: "not_found" });
  };
}
