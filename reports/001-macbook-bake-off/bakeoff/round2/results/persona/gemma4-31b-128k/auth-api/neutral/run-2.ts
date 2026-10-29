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

  // In-memory state: Set of revoked token nonces
  const revokedNonces = new Set<string>();

  // Pre-calculate the HMAC key to avoid importing it on every single request
  const encoder = new TextEncoder();
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  /**
   * Helper to generate a JSON response
   */
  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  /**
   * Binary data <-> Base64 helpers
   */
  const toB64 = (buf: Uint8Array) => btoa(String.fromCharCode(...buf));
  const fromB64 = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  /**
   * Signs a string payload and returns a base64 token
   */
  async function generateToken(payloadObj: object): Promise<string> {
    const payloadStr = JSON.stringify(payloadObj);
    const data = encoder.encode(payloadStr);
    const key = await keyPromise;
    const signature = await crypto.subtle.sign("HMAC", key, data);
    
    return `${toB64(data)}.${toB64(new Uint8Array(signature))}`;
  }

  /**
   * Verifies a token and returns the decoded payload if valid
   */
  async function verifyToken(token: string): Promise<{ payload: any; nonce: string } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const payloadBytes = fromB64(parts[0]);
      const signatureBytes = fromB64(parts[1]);
      const payloadStr = new TextDecoder().decode(payloadBytes);
      const payload = JSON.parse(payloadStr);

      // Check if token is expired
      if (payload.exp <= now().getTime()) return null;

      // Check if token is revoked
      if (revokedNonces.has(payload.nonce)) return null;

      // Verify cryptographic signature
      const key = await keyPromise;
      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        payloadBytes,
      );

      if (!isValid) return null;

      return { payload, nonce: payload.nonce };
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- POST /login ---
    if (path === "/login" && method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }

      if (!body || typeof body !== "object" || typeof body.username !== "string" || typeof body.password !== "string") {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username);
      
      // Uniform 401 for both missing user and wrong password to prevent username enumeration
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAtDate = new Date(now().getTime() + 60 * 60 * 1000);
      const nonce = crypto.getRandomValues(new Uint8Array(16)).join(",");

      const token = await generateToken({
        username: user.username,
        role: user.role,
        exp: expiresAtDate.getTime(),
        nonce: nonce,
      });

      return jsonResponse(200, {
        token,
        expiresAt: expiresAtDate.toISOString(),
      });
    }

    // --- Authenticated Routes ---
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const session = await verifyToken(token);

      if (!session) {
        // If we are on an authenticated route, return 401.
        // However, we only return 401 if the path is actually an auth route.
        // We'll check the path first.
      }

      // Check if path is recognized as an authenticated route
      if (path === "/me" && method === "GET") {
        if (!session) return jsonResponse(401, { error: "unauthorized" });
        return jsonResponse(200, { 
          username: session.payload.username, 
          role: session.payload.role 
        });
      }

      if (path === "/admin/stats" && method === "GET") {
        if (!session) return jsonResponse(401, { error: "unauthorized" });
        if (session.payload.role !== "admin") return jsonResponse(403, { error: "forbidden" });
        
        const adminCount = users.filter(u => u.role === "admin").length;
        return jsonResponse(200, { 
          users: users.length, 
          admins: adminCount 
        });
      }

      if (path === "/logout" && method === "POST") {
        if (!session) return jsonResponse(401, { error: "unauthorized" });
        revokedNonces.add(session.nonce);
        return new Response(null, { status: 204 });
      }
    } else {
      // If it's an authenticated route but the header is missing/malformed, 
      // we check if the route exists first to decide between 401 and 404.
      if ((path === "/me" && method === "GET") || 
          (path === "/admin/stats" && method === "GET") || 
          (path === "/logout" && method === "POST")) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    // --- Everything else ---
    return jsonResponse(404, { error: "not_found" });
  };
}
