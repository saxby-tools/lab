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

  // Lazy-initialized CryptoKey to keep createAuthHandler synchronous
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = () => {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return keyPromise;
  };

  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
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

      const issuedAt = now().getTime();
      const expiresAtDate = new Date(issuedAt + 3600000);
      
      // Token uniqueness: username + timestamp + random nonce
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);
      const nonceStr = btoa(String.fromCharCode(...nonce));
      const payload = `${user.username}|${issuedAt}|${nonceStr}`;
      
      const key = await getKey();
      const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payload),
      );
      const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
      
      const token = `${btoa(payload)}.${signature}`;

      return jsonResponse(200, {
        token,
        expiresAt: expiresAtDate.toISOString(),
      });
    }

    // --- Authenticated Middleware ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // Only check auth for defined authenticated routes, otherwise 404
      if (path === "/me" || path === "/admin/stats" || (path === "/logout" && method === "POST")) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    } else {
      const token = authHeader.substring(7);
      const parts = token.split(".");
      if (parts.length !== 2) {
        if (path === "/me" || path === "/admin/stats" || (path === "/logout" && method === "POST")) {
          return jsonResponse(401, { error: "unauthorized" });
        }
      } else {
        const [encodedPayload, signature] = parts;
        try {
          const payload = atob(encodedPayload);
          const key = await getKey();
          const isValid = await crypto.subtle.verify(
            "HMAC",
            key,
            new Uint8Array(Array.from(atob(signature), (c) => c.charCodeAt(0))),
            encoder.encode(payload),
          );

          if (isValid && !revokedTokens.has(signature)) {
            const [username, issuedAtStr] = payload.split("|");
            const issuedAt = parseInt(issuedAtStr, 10);
            
            if (now().getTime() < issuedAt + 3600000) {
              const user = users.find((u) => u.username === username);
              if (user) {
                // --- Route: GET /me ---
                if (path === "/me" && method === "GET") {
                  return jsonResponse(200, { username: user.username, role: user.role });
                }
                
                // --- Route: GET /admin/stats ---
                if (path === "/admin/stats" && method === "GET") {
                  if (user.role !== "admin") {
                    return jsonResponse(403, { error: "forbidden" });
                  }
                  return jsonResponse(200, {
                    users: users.length,
                    admins: users.filter((u) => u.role === "admin").length,
                  });
                }

                // --- Route: POST /logout ---
                if (path === "/logout" && method === "POST") {
                  revokedTokens.add(signature);
                  return new Response(null, { status: 204 });
                }
              }
            }
          }
        } catch {
          // Fall through to 401 for malformed tokens
        }
        
        if (path === "/me" || path === "/admin/stats" || (path === "/logout" && method === "POST")) {
          return jsonResponse(401, { error: "unauthorized" });
        }
      }
    }

    // --- Default: Not Found ---
    return jsonResponse(404, { error: "not_found" });
  };
}
