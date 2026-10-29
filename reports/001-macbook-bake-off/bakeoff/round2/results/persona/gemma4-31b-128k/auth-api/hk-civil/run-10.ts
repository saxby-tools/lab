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

export function createAuthHandler(options: AuthOptions): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;
  
  // State kept in memory inside the handler closure
  const revokedNonces = new Set<string>();
  const encoder = new TextEncoder();
  let cachedKey: CryptoKey | null = null;

  /**
   * Imports the server secret as a CryptoKey for HMAC-SHA256.
   * Cached to avoid redundant asynchronous imports on every request.
   */
  async function getSecretKey(): Promise<CryptoKey> {
    if (cachedKey) return cachedKey;
    cachedKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return cachedKey;
  }

  function jsonResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  /**
   * Generates a signed token containing the username, expiry timestamp, and a unique nonce.
   * Format: b64(payload).b64(hmac_signature)
   */
  async function generateToken(username: string, expiryTime: number) {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    
    const payload = `${username}:${expiryTime}:${nonce}`;
    const key = await getSecretKey();
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const payloadB64 = btoa(payload);
    
    return { token: `${payloadB64}.${signatureB64}`, nonce };
  }

  /**
   * Validates the token signature, expiration, and revocation status.
   */
  async function verifyToken(token: string) {
    try {
      const parts = token.split(".");
      if (parts.length !== 2) return null;

      const [payloadB64, signatureB64] = parts;
      const payload = atob(payloadB64);
      const [username, expiryStr, nonce] = payload.split(":");
      const expiry = parseInt(expiryStr, 10);

      const key = await getSecretKey();
      const signatureBuf = Uint8Array.from(
        atob(signatureB64).split("").map((c) => c.charCodeAt(0)),
      );

      const isValid = await crypto.subtle.verify("HMAC", key, signatureBuf, encoder.encode(payload));
      
      // Token is invalid if signature is wrong, it's expired, or the specific nonce is revoked
      if (!isValid || now().getTime() >= expiry || revokedNonces.has(nonce)) {
        return null;
      }

      const user = users.find((u) => u.username === username);
      return user ? { user, nonce } : null;
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- Public Route: Login ---
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
      // Response does not reveal whether the username exists or password is wrong
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiryDate = new Date(now().getTime() + 3600000);
      const { token } = await generateToken(user.username, expiryDate.getTime());
      
      return jsonResponse(200, { token, expiresAt: expiryDate.toISOString() });
    }

    // --- Authentication Middleware ---
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const authResult = token ? await verifyToken(token) : null;

    // --- Authenticated Routes ---
    if (path === "/me" && method === "GET") {
      if (!authResult) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authResult.user.username, role: authResult.user.role });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (!authResult) return jsonResponse(401, { error: "unauthorized" });
      if (authResult.user.role !== "admin") return jsonResponse(403, { error: "forbidden" });
      
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      if (!authResult) return jsonResponse(401, { error: "unauthorized" });
      revokedNonces.add(authResult.nonce);
      return new Response(null, { status: 204 });
    }

    // --- Fallback: Not Found ---
    return jsonResponse(404, { error: "not_found" });
  };
}
