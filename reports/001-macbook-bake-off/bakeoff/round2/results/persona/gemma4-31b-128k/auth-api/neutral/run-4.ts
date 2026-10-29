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

  // State kept inside the handler closure
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // We import the secret once when the handler is created
  // This is used for HMAC-SHA256 to ensure tokens cannot be forged
  const secretKey = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  async function jsonResponse(status: number, body?: unknown): Promise<Response> {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (status === 204) {
      return new Response(null, { status, headers });
    }
    return new Response(JSON.stringify(body), { status, headers });
  }

  async function generateToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const timestamp = now().getTime();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceBase64 = btoa(String.fromCharCode(...nonce));
    
    const payload = `${username}:${timestamp}:${nonceBase64}`;
    const payloadBuffer = encoder.encode(payload);
    
    const key = await secretKey;
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, payloadBuffer);
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    
    const token = `${btoa(payload)}.${signatureBase64}`;
    const expiryDate = new Date(timestamp + 3600000);
    
    return {
      token,
      expiresAt: expiryDate.toISOString(),
    };
  }

  async function verifyToken(token: string): Promise<{ user: User } | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const payload = decoder.decode(encoder.encode(atob(payloadB64)));
    const payloadBuffer = encoder.encode(payload);
    const signatureBuffer = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));

    const key = await secretKey;
    const isValid = await crypto.subtle.verify("HMAC", key, signatureBuffer, payloadBuffer);
    if (!isValid) return null;

    const [username, timestampStr] = payload.split(":");
    const timestamp = parseInt(timestampStr, 10);
    
    // Check expiration: Valid until exactly one hour after issuance
    if (isNaN(timestamp) || now().getTime() >= timestamp + 3600000) {
      return null;
    }

    const user = users.find((u) => u.username === username);
    if (!user) return null;

    return { user };
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- POST /login ---
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
      // Use constant time-ish check or just avoid revealing if user exists via generic 401
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await generateToken(user.username);
      return jsonResponse(200, { token, expiresAt });
    }

    // --- Authenticated Routes ---
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authContext = token ? await verifyToken(token) : null;

    if (!authContext) {
      // If it's not the login route and there's no valid token, it's unauthorized
      // unless it's a route that doesn't exist (which we handle at the end)
      if (path === "/me" || path === "/admin/stats" || path === "/logout") {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (path === "/me" && method === "GET") {
      return jsonResponse(200, {
        username: authContext!.user.username,
        role: authContext!.user.role,
      });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (authContext!.user.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      if (token) revokedTokens.add(token);
      return jsonResponse(204);
    }

    // --- Everything else ---
    return jsonResponse(404, { error: "not_found" });
  };
}
