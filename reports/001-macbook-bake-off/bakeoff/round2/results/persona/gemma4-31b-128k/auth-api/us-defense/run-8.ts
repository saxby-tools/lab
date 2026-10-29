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
 * Production-quality Auth API handler for Deno 2.
 * Uses HMAC-SHA256 for token integrity and a server-side revocation list for logouts.
 */
export function createAuthHandler(
  options: AuthOptions,
): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;

  // State kept in memory inside the closure
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();

  // Pre-process secret into a CryptoKey for performance
  // Since importKey is async, we handle it within the request handler or a lazy initializer
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

  async function createToken(username: string, expiresAt: Date): Promise<string> {
    const key = await getHmacKey();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceB64 = btoa(String.fromCharCode(...nonce));
    
    // Payload: username, expiry timestamp, and a unique nonce to ensure 
    // different tokens are issued even for the same user at the same instant.
    const payload = `${username}:${expiresAt.getTime()}:${nonceB64}`;
    const payloadB64 = btoa(payload);
    
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadB64),
    );
    
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return `${payloadB64}.${signatureB64}`;
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const key = await getHmacKey();

    // Verify signature to prevent forgery/alteration
    const signatureBuf = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuf,
      encoder.encode(payloadB64),
    );

    if (!isValid) return null;

    // Decode and verify payload
    try {
      const payload = atob(payloadB64);
      const [username, expiryStr] = payload.split(":");
      const expiry = parseInt(expiryStr, 10);

      if (isNaN(expiry) || now().getTime() >= expiry) {
        return null;
      }

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
  }

  function jsonResponse(status: number, body: any) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
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
      
      // Use a constant-time like check or simply ensure both fail paths return 401
      // to avoid revealing username existence.
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAt = new Date(now().getTime() + 60 * 60 * 1000);
      const token = await createToken(user.username, expiresAt);

      return jsonResponse(200, { 
        token, 
        expiresAt: expiresAt.toISOString() 
      });
    }

    // --- Authenticated Middleware ---
    const authHeader = req.headers.get("Authorization");
    let userContext: { username: string; role: Role } | null = null;
    let tokenValue: string | null = null;

    if (authHeader?.startsWith("Bearer ")) {
      tokenValue = authHeader.substring(7);
      userContext = await verifyToken(tokenValue);
    }

    // --- Route: GET /me ---
    if (method === "GET" && pathname === "/me") {
      if (!userContext) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: userContext.username, role: userContext.role });
    }

    // --- Route: GET /admin/stats ---
    if (method === "GET" && pathname === "/admin/stats") {
      if (!userContext) return jsonResponse(401, { error: "unauthorized" });
      if (userContext.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    // --- Route: POST /logout ---
    if (method === "POST" && pathname === "/logout") {
      if (!userContext || !tokenValue) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(tokenValue);
      return new Response(null, { status: 204 });
    }

    // --- Route: 404 Not Found ---
    return jsonResponse(404, { error: "not_found" });
  };
}
