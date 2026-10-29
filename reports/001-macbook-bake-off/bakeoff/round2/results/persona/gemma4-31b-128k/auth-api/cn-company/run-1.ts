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

export function createAuthHandler(options: AuthOptions): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;
  const revokedTokens = new Set<string>();

  // Pre-compute the HMAC key from the secret string
  const encoder = new TextEncoder();
  const secretKeyData = encoder.encode(secret);

  async function getCryptoKey() {
    return await crypto.subtle.importKey(
      "raw",
      secretKeyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  function jsonResponse(status: number, body: any) {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    return new Response(JSON.stringify(body), { status, headers });
  }

  async function generateToken(username: string, expiryDate: Date): Promise<string> {
    const key = await getCryptoKey();
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const nonceHex = Array.from(nonce).map(b => b.toString(16).padStart(2, "0")).join("");

    const payload = JSON.stringify({
      u: username,
      e: expiryDate.getTime(),
      n: nonceHex,
    });

    const payloadUint8 = encoder.encode(payload);
    const signature = await crypto.subtle.sign("HMAC", key, payloadUint8);
    
    const payloadB64 = btoa(String.fromCharCode(...payloadUint8));
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

    return `${payloadB64}.${signatureB64}`;
  }

  async function verifyToken(token: string): Promise<User | null> {
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const payloadB64 = parts[0];
      const signatureB64 = parts[1];

      const payloadUint8 = new Uint8Array(
        atob(payloadB64).split("").map(c => c.charCodeAt(0))
      );
      const signatureUint8 = new Uint8Array(
        atob(signatureB64).split("").map(c => c.charCodeAt(0))
      );

      const key = await getCryptoKey();
      const isValid = await crypto.subtle.verify("HMAC", key, signatureUint8, payloadUint8);

      if (!isValid) return null;

      const payload = JSON.parse(new TextDecoder().decode(payloadUint8));
      if (typeof payload.u !== "string" || typeof payload.e !== "number") return null;

      // Token is valid until exactly one hour after issue. 
      // At that instant and after, it is expired.
      if (now().getTime() >= payload.e) return null;

      const user = users.find((u) => u.username === payload.u);
      return user || null;
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
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

      if (!body || typeof body !== "object" || typeof body.username !== "string" || typeof body.password !== "string") {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username);
      // Use constant-time check if possible, but simple comparison is often acceptable 
      // given the requirement to avoid revealing username existence via 401.
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAt = new Date(now().getTime() + 60 * 60 * 1000);
      const token = await generateToken(user.username, expiresAt);

      return jsonResponse(200, { token, expiresAt: expiresAt.toISOString() });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (method === "POST" && path === "/login") {
        // Handled above
      } else if (path === "/login") {
        return jsonResponse(404, { error: "not_found" });
      } else {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    const token = authHeader.substring(7);
    const user = await verifyToken(token);

    if (!user) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    if (method === "GET" && path === "/me") {
      return jsonResponse(200, { username: user.username, role: user.role });
    }

    if (method === "GET" && path === "/admin/stats") {
      if (user.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (method === "POST" && path === "/logout") {
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
