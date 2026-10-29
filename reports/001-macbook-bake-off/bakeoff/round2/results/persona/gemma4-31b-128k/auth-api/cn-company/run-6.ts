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

  // Store active sessions in memory. 
  // Key: random token ID, Value: session data.
  const sessions = new Map<string, { username: string; role: Role; expiresAt: Date }>();

  const encoder = new TextEncoder();

  // Initialize HMAC key from secret
  // We use a closure to avoid re-importing the key on every request
  let cryptoKey: CryptoKey;

  async function initKey() {
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  // Helper to create JSON responses
  function jsonResponse(status: number, data: any) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // Helper to generate a cryptographically secure token
  async function generateToken(): Promise<{ token: string; expiresAt: Date }> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const id = btoa(String.fromCharCode(...randomBytes));
    
    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(id),
    );
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    
    const token = `${id}.${sigBase64}`;
    const expiresAt = new Date(now().getTime() + 60 * 60 * 1000);
    
    return { token, expiresAt };
  }

  // Helper to validate the bearer token
  async function authenticate(req: Request): Promise<{ username: string; role: Role } | null> {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [id, sigBase64] = parts;

    // Verify HMAC signature to ensure the token was issued by this server with this secret
    const sigBytes = new Uint8Array(
      atob(sigBase64).split("").map((c) => c.charCodeAt(0)),
    );
    const isValidSig = await crypto.subtle.verify(
      "HMAC",
      cryptoKey,
      sigBytes,
      encoder.encode(id),
    );

    if (!isValidSig) return null;

    const session = sessions.get(id);
    if (!session) return null;

    // Token expires exactly one hour after issuance
    if (now() >= session.expiresAt) {
      sessions.delete(id);
      return null;
    }

    return { username: session.username, role: session.role };
  }

  return async (req: Request): Promise<Response> => {
    // Lazy initialize the crypto key on the first request
    if (!cryptoKey) await initKey();

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "POST" && path === "/login") {
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

      const { token, expiresAt } = await generateToken();
      const id = token.split(".")[0];
      
      sessions.set(id, { 
        username: user.username, 
        role: user.role, 
        expiresAt 
      });

      return jsonResponse(200, { token, expiresAt: expiresAt.toISOString() });
    }

    // Authenticated Routes
    const auth = await authenticate(req);
    if (!auth) {
      // If it's not login, any invalid/missing token on an auth route (or other route)
      // should return 401, provided the route exists.
      // We check routing first to distinguish 404 from 401.
    }

    if (method === "GET" && path === "/me") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: auth.username, role: auth.role });
    }

    if (method === "GET" && path === "/admin/stats") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      if (auth.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      const adminCount = users.filter((u) => u.role === "admin").length;
      return jsonResponse(200, { users: users.length, admins: adminCount });
    }

    if (method === "POST" && path === "/logout") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      
      const authHeader = req.headers.get("Authorization")!;
      const token = authHeader.substring(7);
      const id = token.split(".")[0];
      sessions.delete(id);
      
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
