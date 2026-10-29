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

  // State maintained within the handler closure
  const usersMap = new Map(users.map((u) => [u.username, u]));
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();

  // Import the secret as a CryptoKey for HMAC
  // We wrap the key generation in a promise-based initialization inside the handler
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

  async function jsonResponse(data: any, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function generateToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const key = await getHmacKey();
    const timestamp = now().getTime();
    const nonce = crypto.randomUUID();
    const payload = `${username}:${timestamp}:${nonce}`;
    
    const signatureArray = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload),
    );

    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signatureArray)));
    const payloadB64 = btoa(payload);
    
    const token = `${payloadB64}.${signatureB64}`;
    const expiryDate = new Date(timestamp + 3600 * 1000);

    return {
      token,
      expiresAt: expiryDate.toISOString(),
    };
  }

  async function verifyToken(token: string): Promise<User | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const payload = atob(parts[0]);
      const signatureB64 = parts[1];
      const signatureArray = Uint8Array.from(
        atob(signatureB64).split("").map((c) => c.charCodeAt(0)),
      );

      const key = await getHmacKey();
      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureArray,
        encoder.encode(payload),
      );

      if (!isValid) return null;

      const [username, timestampStr, _nonce] = payload.split(":");
      const timestamp = parseInt(timestampStr, 10);
      
      if (isNaN(timestamp) || now().getTime() >= timestamp + 3600 * 1000) {
        return null;
      }

      return usersMap.get(username) || null;
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // --- POST /login ---
    if (pathname === "/login" && method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      if (
        typeof body !== "object" || 
        body === null || 
        typeof body.username !== "string" || 
        typeof body.password !== "string"
      ) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const user = usersMap.get(body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      const { token, expiresAt } = await generateToken(user.username);
      return jsonResponse({ token, expiresAt });
    }

    // --- Authenticated Routes ---
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const authenticatedUser = token ? await verifyToken(token) : null;

    if (pathname === "/me" && method === "GET") {
      if (!authenticatedUser) return jsonResponse({ error: "unauthorized" }, 401);
      return jsonResponse({
        username: authenticatedUser.username,
        role: authenticatedUser.role,
      });
    }

    if (pathname === "/admin/stats" && method === "GET") {
      if (!authenticatedUser) return jsonResponse({ error: "unauthorized" }, 401);
      if (authenticatedUser.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);

      const admins = users.filter((u) => u.role === "admin").length;
      return jsonResponse({
        users: users.length,
        admins,
      });
    }

    if (pathname === "/logout" && method === "POST") {
      if (!token || !authenticatedUser) return jsonResponse({ error: "unauthorized" }, 401);
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // --- 404 Not Found ---
    return jsonResponse({ error: "not_found" }, 404);
  };
}
