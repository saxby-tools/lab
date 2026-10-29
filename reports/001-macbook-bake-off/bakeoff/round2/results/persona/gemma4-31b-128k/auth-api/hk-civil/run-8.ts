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
  // In-memory session store
  const sessions = new Map<string, { username: string; role: Role; expiresAt: Date }>();
  const getTime = options.now || (() => new Date());
  const encoder = new TextEncoder();

  // Pre-import the cryptographic key for the HMAC operation
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  /**
   * Helper to create JSON responses with the required content type.
   */
  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    const key = await keyPromise;
    const url = new URL(req.url);
    const path = url.pathname;

    // --- ROUTE: POST /login ---
    if (path === "/login" && req.method === "POST") {
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

      const user = options.users.find((u) => u.username === body.username);

      // Security: Generic error to prevent username enumeration
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      // Generate a cryptographically strong random session ID
      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);
      const sessionId = btoa(String.fromCharCode(...randomBytes));

      // Create an HMAC signature of the sessionId to prevent forgery
      const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(sessionId),
      );
      const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

      const token = `${sessionId}.${signature}`;
      const expiresAt = new Date(getTime().getTime() + 60 * 60 * 1000);

      sessions.set(sessionId, {
        username: user.username,
        role: user.role,
        expiresAt,
      });

      return jsonResponse(200, {
        token,
        expiresAt: expiresAt.toISOString(),
      });
    }

    // --- AUTHENTICATION MIDDLEWARE FOR REMAINING ROUTES ---
    const authHeader = req.headers.get("Authorization");
    let authenticatedUser: { sessionId: string; username: string; role: Role } | null = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const parts = token.split(".");

      if (parts.length === 2) {
        const [sessionId, signature] = parts;
        try {
          const sigBytes = new Uint8Array(
            atob(signature).split("").map((c) => c.charCodeAt(0)),
          );

          // 1. Verify that the token was signed by this server's secret
          const isValidSig = await crypto.subtle.verify(
            "HMAC",
            key,
            sigBytes,
            encoder.encode(sessionId),
          );

          if (isValidSig) {
            const session = sessions.get(sessionId);

            // 2. Check if the session exists and is not expired
            if (session && getTime() < session.expiresAt) {
              authenticatedUser = {
                sessionId,
                username: session.username,
                role: session.role,
              };
            }
          }
        } catch {
          // Handle malformed base64 strings silently
        }
      }
    }

    // --- AUTHENTICATED ROUTES ---
    if (authenticatedUser) {
      if (path === "/me" && req.method === "GET") {
        return jsonResponse(200, {
          username: authenticatedUser.username,
          role: authenticatedUser.role,
        });
      }

      if (path === "/admin/stats" && req.method === "GET") {
        if (authenticatedUser.role !== "admin") {
          return jsonResponse(403, { error: "forbidden" });
        }
        return jsonResponse(200, {
          users: options.users.length,
          admins: options.users.filter((u) => u.role === "admin").length,
        });
      }

      if (path === "/logout" && req.method === "POST") {
        sessions.delete(authenticatedUser.sessionId);
        return new Response(null, { status: 204 });
      }
    } else {
      // If the route is one of the authenticated ones but the user is not auth'd
      if (
        (path === "/me" && req.method === "GET") ||
        (path === "/admin/stats" && req.method === "GET") ||
        (path === "/logout" && req.method === "POST")
      ) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    // --- EVERYTHING ELSE ---
    return jsonResponse(404, { error: "not_found" });
  };
}
