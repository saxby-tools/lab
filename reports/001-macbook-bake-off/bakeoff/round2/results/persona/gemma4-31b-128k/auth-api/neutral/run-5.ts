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
  const encoder = new TextEncoder();
  const revokedTokens = new Set<string>();

  // Pre-import the secret as a CryptoKey for HMAC
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
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

  /**
   * Token structure: base64(payload).base64(signature)
   * Payload: username|expiry|nonce
   */
  async function generateToken(username: string, expiry: number): Promise<string> {
    const key = await keyPromise;
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    
    const payload = `${username}|${expiry}|${nonce}`;
    const payloadB64 = btoa(payload);
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadB64),
    );
    
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return `${payloadB64}.${signatureB64}`;
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const key = await keyPromise;

    // Verify HMAC signature
    const signatureBytes = new Uint8Array(
      atob(signatureB64).split("").map((c) => c.charCodeAt(0)),
    );
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      encoder.encode(payloadB64),
    );

    if (!isValid) return null;

    // Parse and verify payload
    try {
      const payload = atob(payloadB64);
      const [username, expiryStr] = payload.split("|");
      const expiry = parseInt(expiryStr, 10);

      if (isNaN(expiry) || now().getTime() >= expiry) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
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
        // Generic error to prevent username enumeration
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAtDate = new Date(now().getTime() + 3600000);
      const expiresAt = expiresAtDate.toISOString();
      const token = await generateToken(user.username, expiresAtDate.getTime());

      return jsonResponse(200, { token, expiresAt });
    }

    // Authentication Middleware for remaining routes
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") 
      ? authHeader.slice(7) 
      : null;
    const authUser = token ? await verifyToken(token) : null;

    if (path === "/me" && method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      if (authUser.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      if (!token || !authUser) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // Default: Not Found
    return jsonResponse(404, { error: "not_found" });
  };
}
