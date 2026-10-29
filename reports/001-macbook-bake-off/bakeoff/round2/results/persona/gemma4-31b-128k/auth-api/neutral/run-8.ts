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

  // We cache the CryptoKey to avoid re-importing on every request.
  let hmacKey: CryptoKey | null = null;

  async function getHmacKey() {
    if (!hmacKey) {
      hmacKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return hmacKey;
  }

  function jsonResponse(status: number, body: any) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function generateToken(username: string) {
    const timestamp = now().getTime();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceB64 = btoa(String.fromCharCode(...nonce));
    
    const payload = `${username}|${timestamp}|${nonceB64}`;
    const payloadB64 = btoa(payload);
    
    const key = await getHmacKey();
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadB64),
    );
    
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return {
      token: `${payloadB64}.${signatureB64}`,
      issuedAt: timestamp,
    };
  }

  async function verifyToken(token: string) {
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const key = await getHmacKey();
    
    const signatureBuf = new Uint8Array(
      atob(signatureB64).split("").map((c) => c.charCodeAt(0)),
    );

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuf,
      encoder.encode(payloadB64),
    );

    if (!isValid) return null;

    const payload = atob(payloadB64);
    const [username, timestampStr, _nonce] = payload.split("|");
    const issuedAt = parseInt(timestampStr, 10);
    
    if (isNaN(issuedAt)) return null;

    // Token is valid until exactly one hour after issuance.
    // At that instant and after, it is expired.
    if (now().getTime() >= issuedAt + 3600000) {
      return null;
    }

    const user = users.find((u) => u.username === username);
    if (!user) return null;

    return { user, token };
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
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const { token, issuedAt } = await generateToken(user.username);
      const expiresAt = new Date(issuedAt + 3600000).toISOString();
      
      return jsonResponse(200, { token, expiresAt });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (pathname === "/login" && req.method === "POST") {
        // Handled above
      } else if (["/me", "/admin/stats", "/logout"].includes(pathname)) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.split(" ")[1];
    const authContext = token ? await verifyToken(token) : null;

    if (!authContext) {
      if (["/me", "/admin/stats", "/logout"].includes(pathname)) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    } else {
      const { user, token: verifiedToken } = authContext;

      if (pathname === "/me" && req.method === "GET") {
        return jsonResponse(200, { username: user.username, role: user.role });
      }

      if (pathname === "/admin/stats" && req.method === "GET") {
        if (user.role !== "admin") {
          return jsonResponse(403, { error: "forbidden" });
        }
        return jsonResponse(200, {
          users: users.length,
          admins: users.filter((u) => u.role === "admin").length,
        });
      }

      if (pathname === "/logout" && req.method === "POST") {
        revokedTokens.add(verifiedToken);
        return new Response(null, { status: 204 });
      }
    }

    // Everything else
    return jsonResponse(404, { error: "not_found" });
  };
}
