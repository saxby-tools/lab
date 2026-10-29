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

  // State maintained within the handler's closure
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();

  // Initialize the HMAC key from the server secret
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  /**
   * Helper to send JSON responses
   */
  const respond = (status: number, body: any) => {
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    return response;
  };

  /**
   * Helper to convert ArrayBuffer to a hex string for visible ASCII tokens
   */
  const bufToHex = (buf: ArrayBuffer) => {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  /**
   * Validates the bearer token and returns the user associated with it
   */
  const validateToken = async (token: string): Promise<{ user: User } | null> => {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureHex] = parts;

    try {
      const payloadStr = atob(payloadB64);
      const [username, expiryStr, nonce] = payloadStr.split("|");
      const expiry = parseInt(expiryStr, 10);

      if (isNaN(expiry) || !username || !nonce) return null;

      // Check expiration: valid until exactly one hour after issue. 
      // At that instant and after, it is expired.
      if (now().getTime() >= expiry) return null;

      // Verify integrity using HMAC-SHA256
      const key = await keyPromise;
      const payloadBuf = encoder.encode(payloadStr);
      const signatureBuf = await crypto.subtle.sign("HMAC", key, payloadBuf);
      const expectedHex = bufToHex(signatureBuf);

      if (signatureHex !== expectedHex) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { user };
    } catch {
      return null;
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Route: POST /login
    if (pathname === "/login" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return respond(400, { error: "invalid_request" });
      }

      if (
        typeof body !== "object" ||
        body === null ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return respond(400, { error: "invalid_request" });
      }

      const { username, password } = body;
      const user = users.find((u) => u.username === username);

      // Constant-time check simulation: avoid leaking username existence
      if (!user || user.password !== password) {
        return respond(401, { error: "invalid_credentials" });
      }

      // Create token: payload includes username, expiry, and a random nonce
      const expiryDate = new Date(now().getTime() + 3600000);
      const nonce = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
      const payloadStr = `${user.username}|${expiryDate.getTime()}|${nonce}`;
      const payloadB64 = btoa(payloadStr);

      const key = await keyPromise;
      const signatureBuf = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payloadStr),
      );
      const token = `${payloadB64}.${bufToHex(signatureBuf)}`;

      return respond(200, {
        token,
        expiresAt: expiryDate.toISOString(),
      });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // If it's not /login, and it lacks the header, it's either 401 or 404
      if (pathname === "/login" && req.method === "POST") {
        // Handled above, but logically reaches here if logic fails
      } else if (
        pathname === "/me" ||
        pathname === "/admin/stats" ||
        pathname === "/logout"
      ) {
        return respond(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.substring(7);
    const authResult = token ? await validateToken(token) : null;

    if (!authResult) {
      if (pathname === "/me" || pathname === "/admin/stats" || pathname === "/logout") {
        return respond(401, { error: "unauthorized" });
      }
    }

    if (authResult) {
      const { user } = authResult;

      if (pathname === "/me" && req.method === "GET") {
        return respond(200, { username: user.username, role: user.role });
      }

      if (pathname === "/admin/stats" && req.method === "GET") {
        if (user.role !== "admin") {
          return respond(403, { error: "forbidden" });
        }
        return respond(200, {
          users: users.length,
          admins: users.filter((u) => u.role === "admin").length,
        });
      }

      if (pathname === "/logout" && req.method === "POST") {
        revokedTokens.add(token!);
        return new Response(null, { status: 204 });
      }
    }

    // Everything else
    return respond(404, { error: "not_found" });
  };
}
