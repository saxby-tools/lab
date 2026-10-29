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

  // In-memory store for revoked tokens. 
  // Since we cannot start timers, this grows until the process restarts.
  const revokedTokens = new Set<string>();

  /**
   * Utility to create JSON responses with the required content type.
   */
  const jsonResponse = (status: number, body: any) => {
    const text = JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Web Crypto HMAC helper to sign and verify tokens.
   */
  const getCryptoKey = async () => {
    return await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  };

  /**
   * Token Structure: base64(payload).base64(hmac)
   * Payload: username|expiry|nonce
   */
  const generateToken = async (username: string, expiryDate: Date) => {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceHex = Array.from(nonce).map(b => b.toString(16).padStart(2, '0')).join('');
    const payload = `${username}|${expiryDate.getTime()}|${nonceHex}`;
    const payloadUint8 = new TextEncoder().encode(payload);
    
    const key = await getCryptoKey();
    const signature = await crypto.subtle.sign("HMAC", key, payloadUint8);
    
    const payloadBase64 = btoa(String.fromCharCode(...payloadUint8));
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    
    return `${payloadBase64}.${signatureBase64}`;
  };

  const verifyToken = async (token: string) => {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const payloadUint8 = new Uint8Array(
        atob(parts[0]).split("").map(c => c.charCodeAt(0))
      );
      const signatureUint8 = new Uint8Array(
        atob(parts[1]).split("").map(c => c.charCodeAt(0))
      );

      const key = await getCryptoKey();
      const isValid = await crypto.subtle.verify("HMAC", key, signatureUint8, payloadUint8);
      if (!isValid) return null;

      const payload = new TextDecoder().decode(payloadUint8);
      const [username, expiryStr, _nonce] = payload.split("|");
      const expiry = parseInt(expiryStr, 10);

      if (isNaN(expiry) || now().getTime() >= expiry) return null;

      const user = users.find(u => u.username === username);
      if (!user) return null;

      return user;
    } catch {
      return null;
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- Public Route: /login ---
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

      const user = users.find(u => u.username === body.username);
      // Constant-time-like check: always evaluate the password check if user exists
      // to avoid timing leaks, though simple array find is used here per requirements.
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
      const token = await generateToken(user.username, expiryDate);

      return jsonResponse(200, { 
        token, 
        expiresAt: expiryDate.toISOString() 
      });
    }

    // --- Authenticated Route Logic ---
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authenticatedUser = token ? await verifyToken(token) : null;

    if (!authenticatedUser) {
      // If it's not the login route, any invalid token access results in 401.
      // But we must first check if the route even exists to return 404 vs 401.
      const validRoutes = ["/me", "/admin/stats", "/logout"];
      if (!validRoutes.includes(path)) {
        return jsonResponse(404, { error: "not_found" });
      }
      return jsonResponse(401, { error: "unauthorized" });
    }

    // --- Protected Routes ---
    if (path === "/me" && method === "GET") {
      return jsonResponse(200, { 
        username: authenticatedUser.username, 
        role: authenticatedUser.role 
      });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (authenticatedUser.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter(u => u.role === "admin").length
      });
    }

    if (path === "/logout" && method === "POST") {
      if (token) revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // --- Default: 404 ---
    return jsonResponse(404, { error: "not_found" });
  };
}
