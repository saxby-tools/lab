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

  // State maintained in the closure of the handler
  const revokedTokens = new Set<string>();
  
  // Pre-calculate the CryptoKey from the secret for performance and consistency
  const encoder = new TextEncoder();
  const secretKeyData = encoder.encode(secret);
  
  // We wrap the handler to initialize the key asynchronously if needed, 
  // but since createAuthHandler is synchronous and the handler is async,
  // we can import the key inside the handler or use a promise.
  const keyPromise = crypto.subtle.importKey(
    "raw",
    secretKeyData,
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
    const key = await keyPromise;
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(data),
    );
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  };

  const verify = async (data: string, signatureB64: string): Promise<boolean> => {
    const key = await keyPromise;
    const signature = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(data),
    );
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // --- Route: POST /login ---
    if (pathname === "/login" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }

      if (
        !body ||
        typeof body !== "object" ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
      const expiryTime = expiryDate.getTime();
      
      // Generate a nonce to ensure token uniqueness even for the same user at the same time
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const payload = JSON.stringify({
        u: user.username,
        e: expiryTime,
        n: btoa(String.fromCharCode(...nonce)),
      });
      
      const payloadB64 = btoa(payload);
      const signature = await sign(payloadB64);
      const token = `${payloadB64}.${signature}`;

      return jsonResponse(200, {
        token,
        expiresAt: expiryDate.toISOString(),
      });
    }

    // --- Authenticated Middleware ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (pathname === "/login" && req.method === "POST") {
        // Handled above, but for logical flow:
      } else if (
        pathname === "/me" || 
        pathname === "/admin/stats" || 
        (pathname === "/logout" && req.method === "POST")
      ) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.split(" ")[1];
    let authenticatedUser: User | null = null;
    let currentToken: string | null = null;

    if (token) {
      const parts = token.split(".");
      if (parts.length === 2) {
        const [payloadB64, signature] = parts;
        const isValid = await verify(payloadB64, signature);
        
        if (isValid) {
          try {
            const payload = JSON.parse(atob(payloadB64));
            const nowTime = now().getTime();
            
            if (nowTime < payload.e && !revokedTokens.has(token)) {
              const user = users.find((u) => u.username === payload.u);
              if (user) {
                authenticatedUser = user;
                currentToken = token;
              }
            }
          } catch {
            // Invalid JSON in payload
          }
        }
      }
    }

    // --- Route: GET /me ---
    if (pathname === "/me" && req.method === "GET") {
      if (!authenticatedUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { 
        username: authenticatedUser.username, 
        role: authenticatedUser.role 
      });
    }

    // --- Route: GET /admin/stats ---
    if (pathname === "/admin/stats" && req.method === "GET") {
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
    if (pathname === "/logout" && req.method === "POST") {
      if (!currentToken) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(currentToken);
      return new Response(null, { status: 204 });
    }

    // --- Everything else ---
    return jsonResponse(404, { error: "not_found" });
  };
}
