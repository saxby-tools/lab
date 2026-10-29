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

/**
 * createAuthHandler implements a secure login API.
 * 
 * Security implementation details:
 * - Token: HMAC-SHA256 signed string containing username, expiry, and a random nonce.
 * - Secret: Used as the key for the HMAC signature.
 * - Revocation: A Set tracks revoked tokens (used for logout).
 * - Expiration: Verified against the provided `now()` function.
 * - Privacy: Generic error messages to prevent username enumeration.
 */
export function createAuthHandler(
  options: AuthOptions,
): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();

  // Pre-calculate keys or cached values if possible, but importKey is async.
  // We will cache the CryptoKey after the first request to avoid repeated overhead.
  let hmacKey: CryptoKey | null = null;

  async function getHmacKey(): Promise<CryptoKey> {
    if (hmacKey) return hmacKey;
    hmacKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return hmacKey;
  }

  function jsonResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const method = req.method;

    // --- Route: POST /login ---
    if (method === "POST" && pathname === "/login") {
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
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      // Token Generation
      const expiryDate = new Date(now().getTime() + 3600000);
      const expiresAt = expiryDate.toISOString();
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const nonceB64 = btoa(String.fromCharCode(...nonce));
      
      const payload = `${user.username}|${expiresAt}|${nonceB64}`;
      const key = await getHmacKey();
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
      
      const token = `${btoa(payload)}.${signatureB64}`;

      return jsonResponse(200, { token, expiresAt });
    }

    // --- Authenticated Routes Middle-ware ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // If it's not login, any other route requiring auth (or non-existent routes)
      // will be handled by the final 404 or 401.
      // However, we must ensure that requests to auth routes without tokens return 401.
      if (pathname === "/me" || pathname === "/admin/stats" || pathname === "/logout") {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.split(" ")[1];
    let authenticatedUser: User | null = null;

    if (token) {
      try {
        const [payloadB64, signatureB64] = token.split(".");
        if (!payloadB64 || !signatureB64) throw new Error();

        const payload = atob(payloadB64);
        const key = await getHmacKey();
        const signature = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
        
        const isValid = await crypto.subtle.verify(
          "HMAC",
          key,
          signature,
          encoder.encode(payload),
        );

        if (!isValid || revokedTokens.has(token)) throw new Error();

        const [username, expiresAtStr] = payload.split("|");
        const expiryDate = new Date(expiresAtStr);
        if (now() >= expiryDate) throw new Error();

        authenticatedUser = users.find((u) => u.username === username) || null;
        if (!authenticatedUser) throw new Error();
      } catch {
        // Fall through to 401 for any token validation failure
        if (pathname === "/me" || pathname === "/admin/stats" || pathname === "/logout") {
          return jsonResponse(401, { error: "unauthorized" });
        }
      }
    }

    // --- Route: GET /me ---
    if (method === "GET" && pathname === "/me") {
      if (!authenticatedUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, {
        username: authenticatedUser.username,
        role: authenticatedUser.role,
      });
    }

    // --- Route: GET /admin/stats ---
    if (method === "GET" && pathname === "/admin/stats") {
      if (!authenticatedUser) return jsonResponse(401, { error: "unauthorized" });
      if (authenticatedUser.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // --- Route: POST /logout ---
    if (method === "POST" && pathname === "/logout") {
      if (!token || !authenticatedUser) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // --- Everything else ---
    return jsonResponse(404, { error: "not_found" });
  };
}
