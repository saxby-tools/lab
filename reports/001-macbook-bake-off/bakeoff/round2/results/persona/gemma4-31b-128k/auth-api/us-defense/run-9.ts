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

  // In-memory state for active sessions
  // Key: nonce, Value: session data
  const sessions = new Map<string, { username: string; expiresAt: Date }>();

  // Pre-calculate the CryptoKey from the secret for HMAC
  const encoder = new TextEncoder();
  const secretKeyData = encoder.encode(secret);
  
  async function getHmacKey() {
    return await crypto.subtle.importKey(
      "raw",
      secretKeyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  async function signNonce(nonce: string): Promise<string> {
    const key = await getHmacKey();
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(nonce),
    );
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  async function verifyToken(authHeader: string | null): Promise<{ 
    username: string, 
    role: Role, 
    nonce: string 
  } | null> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [nonce, providedSig] = parts;

    // 1. Cryptographic verification: Token must be bound to the server secret
    const expectedSig = await signNonce(nonce);
    if (providedSig !== expectedSig) return null;

    // 2. Session verification: Must exist in memory
    const session = sessions.get(nonce);
    if (!session) return null;

    // 3. Expiry verification: Valid until exactly one hour after issuance
    if (now() >= session.expiresAt) {
      sessions.delete(nonce);
      return null;
    }

    const user = users.find((u) => u.username === session.username);
    if (!user) return null;

    return { username: user.username, role: user.role, nonce };
  }

  function jsonResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // POST /login
    if (pathname === "/login" && req.method === "POST") {
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
      
      // To prevent username enumeration, we use a consistent response
      // regardless of whether the user exists or the password is wrong.
      if (user && user.password === body.password) {
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        const signature = await signNonce(nonce);
        const token = `${nonce}.${signature}`;
        
        const expiresAt = new Date(now().getTime() + 3600000);
        sessions.set(nonce, { username: user.username, expiresAt });

        return jsonResponse(200, {
          token,
          expiresAt: expiresAt.toISOString(),
        });
      }

      return jsonResponse(401, { error: "invalid_credentials" });
    }

    // Authenticated Routes
    const authHeader = req.headers.get("Authorization");
    const auth = await verifyToken(authHeader);

    if (!auth) {
      // Only login is public; everything else requiring auth or unknown paths handled below
      if (pathname === "/login" && req.method === "POST") {
        // Handled above
      } else if (
        (pathname === "/me" && req.method === "GET") ||
        (pathname === "/admin/stats" && req.method === "GET") ||
        (pathname === "/logout" && req.method === "POST")
      ) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (auth) {
      if (pathname === "/me" && req.method === "GET") {
        return jsonResponse(200, { username: auth.username, role: auth.role });
      }

      if (pathname === "/admin/stats" && req.method === "GET") {
        if (auth.role !== "admin") {
          return jsonResponse(403, { error: "forbidden" });
        }
        return jsonResponse(200, {
          users: users.length,
          admins: users.filter((u) => u.role === "admin").length,
        });
      }

      if (pathname === "/logout" && req.method === "POST") {
        sessions.delete(auth.nonce);
        return new Response(null, { status: 204 });
      }
    }

    // Everything else
    return jsonResponse(404, { error: "not_found" });
  };
}
