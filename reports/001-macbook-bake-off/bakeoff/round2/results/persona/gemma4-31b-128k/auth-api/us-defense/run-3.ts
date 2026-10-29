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
  const decoder = new TextDecoder();

  // Pre-import the secret key to avoid repeating it on every request
  const cryptoKeyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  async function jsonResponse(status: number, body: any): Promise<Response> {
    const res = new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    return res;
  }

  async function verifyToken(token: string): Promise<User | null> {
    if (!token) return null;
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const payloadB64 = parts[0];
      const signatureB64 = parts[1];
      const payloadStr = decoder.decode(Uint8Array.from(atob(payloadB64), (c) => c.charCodeAt(0)));
      const signatureBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));

      const key = await cryptoKeyPromise;
      const actualSignature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payloadStr),
      );

      const actualSignatureBytes = new Uint8Array(await actualSignature);
      if (actualSignatureBytes.length !== signatureBytes.length) return null;
      
      // Constant-time comparison to prevent timing attacks
      let diff = 0;
      for (let i = 0; i < signatureBytes.length; i++) {
        diff |= signatureBytes[i] ^ actualSignatureBytes[i];
      }
      if (diff !== 0) return null;

      const [username, expiryStr] = payloadStr.split("|");
      const expiryDate = new Date(expiryStr);
      if (isNaN(expiryDate.getTime()) || now().getTime() >= expiryDate.getTime()) {
        return null;
      }

      const user = users.find((u) => u.username === username);
      return user || null;
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // POST /login
    if (path === "/login" && req.method === "POST") {
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
      // Use a standard check; since we only have the password, we check equality.
      // We must return 401 for both user-not-found and wrong-password.
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiryDate = new Date(now().getTime() + 3600 * 1000);
      const expiresAt = expiryDate.toISOString();
      
      // Generate unique token: payload includes username, expiry, and a random nonce
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);
      const nonceB64 = btoa(String.fromCharCode(...nonce));
      const payload = `${user.username}|${expiresAt}|${nonceB64}`;
      
      const key = await cryptoKeyPromise;
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      const signatureBytes = new Uint8Array(await signature);
      const signatureB64 = btoa(String.fromCharCode(...signatureBytes));
      
      const token = `${btoa(payload)}.${signatureB64}`;
      
      return jsonResponse(200, { token, expiresAt });
    }

    // Authenticated Routes
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authenticatedUser = await verifyToken(token);

    if (!authenticatedUser) {
      // Only the login route allows unauthenticated requests.
      // We've already handled /login above.
      // We check other routes here. If they aren't /login, and token is invalid, 401.
      // But we must first check if the path is one of the known authenticated paths.
      if (path === "/me" || path === "/admin/stats" || path === "/logout") {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    // GET /me
    if (path === "/me" && req.method === "GET") {
      if (!authenticatedUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authenticatedUser.username, role: authenticatedUser.role });
    }

    // GET /admin/stats
    if (path === "/admin/stats" && req.method === "GET") {
      if (!authenticatedUser) return jsonResponse(401, { error: "unauthorized" });
      if (authenticatedUser.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // POST /logout
    if (path === "/logout" && req.method === "POST") {
      if (!authenticatedUser || !token) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return jsonResponse(404, { error: "not_found" });
  };
}
