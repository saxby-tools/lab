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
 * Implements signed tokens with revocation and RBAC.
 */
export function createAuthHandler(options: AuthOptions): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Pre-import the HMAC key for performance, though we must handle it as a Promise
  const secretKeyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  /**
   * Helper to generate a URL-safe Base64 string from an ArrayBuffer
   */
  const bufferToBase64 = (buf: ArrayBuffer): string => {
    const binary = String.fromCharCode(...new Uint8Array(buf));
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };

  /**
   * Helper to decode a URL-safe Base64 string back to a string
   */
  const base64ToUtf8 = (base64: string): string => {
    const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return decoder.decode(bytes);
  };

  /**
   * Signs a payload using HMAC-SHA256
   */
  const signPayload = async (payload: string): Promise<string> => {
    const key = await secretKeyPromise;
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return bufferToBase64(signature);
  };

  /**
   * Validates the token and returns the user if successful
   */
  const authenticate = async (req: Request): Promise<{ user: User; token: string } | null> => {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.slice(7);
    if (!token || token.includes(" ")) return null;
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    
    // Verify signature first to prevent tampering/guessing
    const expectedSignature = await signPayload(payloadB64);
    if (signatureB64 !== expectedSignature) return null;

    try {
      const payload = base64ToUtf8(payloadB64);
      const [username, nonce, expiryStr] = payload.split("|");
      if (!username || !nonce || !expiryStr) return null;

      const expiry = new Date(expiryStr);
      if (now() >= expiry) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { user, token };
    } catch {
      return null;
    }
  };

  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // POST /login
    if (pathname === "/login" && req.method === "POST") {
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
      // Constant-time check not strictly required by prompt, but check credentials
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAt = new Date(now().getTime() + 60 * 60 * 1000);
      const expiresAtIso = expiresAt.toISOString();
      
      // Token components: username, random nonce for uniqueness, and expiration
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      
      const payload = `${user.username}|${nonce}|${expiresAtIso}`;
      const payloadB64 = bufferToBase64(encoder.encode(payload));
      const signature = await signPayload(payloadB64);
      const token = `${payloadB64}.${signature}`;

      return jsonResponse(200, { token, expiresAt: expiresAtIso });
    }

    // Authenticated Routes
    const auth = await authenticate(req);
    if (!auth) {
      // If the path is /login, we already handled it. 
      // For any other path requiring auth, return 401.
      // But first, check if the path is even valid.
      const validPaths = ["/me", "/admin/stats", "/logout"];
      if (validPaths.includes(pathname)) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (auth) {
      const { user, token } = auth;

      // GET /me
      if (pathname === "/me" && req.method === "GET") {
        return jsonResponse(200, { username: user.username, role: user.role });
      }

      // GET /admin/stats
      if (pathname === "/admin/stats" && req.method === "GET") {
        if (user.role !== "admin") {
          return jsonResponse(403, { error: "forbidden" });
        }
        return jsonResponse(200, {
          users: users.length,
          admins: users.filter((u) => u.role === "admin").length,
        });
      }

      // POST /logout
      if (pathname === "/logout" && req.method === "POST") {
        revokedTokens.add(token);
        return new Response(null, { status: 204 });
      }
    }

    // Everything else
    return jsonResponse(404, { error: "not_found" });
  };
}
