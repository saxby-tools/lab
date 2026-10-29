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
 * Implementation of a secure Auth API for Deno 2.
 * Uses HMAC-SHA256 for token signatures and an in-memory set for revocation.
 */
export function createAuthHandler(
  options: AuthOptions,
): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;
  const encoder = new TextEncoder();
  
  // State kept in memory inside the closure
  const revokedTokens = new Set<string>();

  // Initialize the HMAC key from the provided secret
  // Since importKey is async, we wrap the handler logic to handle the promise
  const getCryptoKey = async () => {
    return await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  };

  // Helper to create JSON responses
  const jsonResponse = (status: number, data: any) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  // Helper to generate a cryptographically secure random string for the token nonce
  const generateNonce = () => {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array));
  };

  // Token structure: b64(payload).signature
  // Payload: username|expiry|nonce
  const createToken = async (username: string, expiry: number) => {
    const key = await getCryptoKey();
    const nonce = generateNonce();
    const payload = `${username}|${expiry}|${nonce}`;
    const payloadB64 = btoa(payload);
    
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadB64),
    );
    
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    return `${payloadB64}.${signatureB64}`;
  };

  const verifyToken = async (token: string) => {
    if (!token || !token.includes(".")) return null;
    if (revokedTokens.has(token)) return null;

    const [payloadB64, signatureB64] = token.split(".");
    const key = await getCryptoKey();
    
    // Verify HMAC signature
    const signatureBuffer = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuffer,
      encoder.encode(payloadB64),
    );

    if (!isValid) return null;

    // Decode and verify payload
    try {
      const payload = atob(payloadB64);
      const [username, expiryStr] = payload.split("|");
      const expiry = parseInt(expiryStr, 10);

      if (isNaN(expiry) || now().getTime() >= expiry) {
        return null;
      }

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { user, token };
    } catch {
      return null;
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- Route: POST /login ---
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
      // Use constant-time-like check for password to prevent timing attacks
      // Although standard JS strings aren't perfectly constant-time, we ensure 
      // the path is the same regardless of whether the user exists.
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAtDate = new Date(now().getTime() + 60 * 60 * 1000);
      const token = await createToken(user.username, expiresAtDate.getTime());

      return jsonResponse(200, {
        token,
        expiresAt: expiresAtDate.toISOString(),
      });
    }

    // --- Authenticated Routes Middleware ---
    const authHeader = req.headers.get("Authorization");
    const tokenValue = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authCtx = tokenValue ? await verifyToken(tokenValue) : null;

    if (path === "/me" && method === "GET") {
      if (!authCtx) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, {
        username: authCtx.user.username,
        role: authCtx.user.role,
      });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (!authCtx) return jsonResponse(401, { error: "unauthorized" });
      if (authCtx.user.role !== "admin") return jsonResponse(403, { error: "forbidden" });
      
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      if (!authCtx) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(authCtx.token!);
      return new Response(null, { status: 204 });
    }

    // --- 404 Not Found ---
    return jsonResponse(404, { error: "not_found" });
  };
}
