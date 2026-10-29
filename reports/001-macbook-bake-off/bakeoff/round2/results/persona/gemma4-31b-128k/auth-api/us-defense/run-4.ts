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

  // Pre-import the secret key for HMAC-SHA256
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  // Helper to send JSON responses
  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  // Helper for binary to base64 and vice versa
  const bufToBase64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const base64ToBuf = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)).buffer;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const key = await keyPromise;

    // --- Middleware: Token Verification ---
    const verifyToken = async (): Promise<{ user: User; token: string } | null> => {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

      const token = authHeader.substring(7);
      if (!token || revokedTokens.has(token)) return null;

      const parts = token.split(".");
      if (parts.length !== 2) return null;

      const [payloadB64, sigB64] = parts;
      try {
        const payloadStr = atob(payloadB64);
        const payload = JSON.parse(payloadStr);
        
        // Check signature
        const data = encoder.encode(payloadB64);
        const signature = base64ToBuf(sigB64);
        const isValid = await crypto.subtle.verify("HMAC", key, signature, data);
        if (!isValid) return null;

        // Check expiry (token is valid UNTIL exactly one hour after issue)
        if (now().getTime() >= payload.exp) return null;

        const user = users.find((u) => u.username === payload.sub);
        if (!user) return null;

        return { user, token };
      } catch {
        return null;
      }
    };

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
      // Use consistent error to prevent username enumeration
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const issueTime = now().getTime();
      const expiryTime = issueTime + 3600000; // 1 hour
      const nonce = crypto.getRandomValues(new Uint32Array(1))[0];

      const payload = JSON.stringify({
        sub: user.username,
        exp: expiryTime,
        nonce: nonce,
      });
      const payloadB64 = btoa(payload);
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
      const token = `${payloadB64}.${bufToBase64(signature)}`;

      return jsonResponse(200, {
        token,
        expiresAt: new Date(expiryTime).toISOString(),
      });
    }

    // --- Authenticated Routes ---
    const auth = await verifyToken();
    if (!auth) {
      // Only proceed to check 404 if we aren't hitting a known auth route
      if (path === "/me" || path === "/admin/stats" || (path === "/logout" && method === "POST")) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (path === "/me" && method === "GET") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: auth.user.username, role: auth.user.role });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      if (auth.user.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      if (!auth) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(auth.token);
      return new Response(null, { status: 204 });
    }

    // --- Default: Not Found ---
    return jsonResponse(404, { error: "not_found" });
  };
}
