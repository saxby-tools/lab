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
  const decoder = new TextDecoder();

  // State for revoked tokens
  const revokedTokens = new Set<string>();

  // Pre-import the secret as a CryptoKey for HMAC-SHA256
  // We use a promise to handle the async nature of importKey within the closure
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const respond = (status: number, body?: unknown) => {
    const headers = new Headers();
    if (body !== undefined) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    return new Response(body ? JSON.stringify(body) : undefined, {
      status,
      headers,
    });
  };

  // Helper to encode binary to base64 ASCII
  const bufToBase64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  // Helper to decode base64 ASCII to binary
  const base64ToBuf = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    // --- Route: POST /login ---
    if (path === "/login" && method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return respond(400, { error: "invalid_request" });
      }

      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return respond(400, { error: "invalid_request" });
      }

      const user = users.find(
        (u) => u.username === body.username && u.password === body.password,
      );

      if (!user) {
        return respond(401, { error: "invalid_credentials" });
      }

      // Token generation
      const jti = bufToBase64(crypto.getRandomValues(new Uint8Array(16)));
      const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
      const expiresAt = expiryDate.toISOString();
      
      const payload = JSON.stringify({
        u: user.username,
        exp: expiryDate.getTime(),
        jti: jti,
      });
      
      const payloadBuf = encoder.encode(payload);
      const key = await keyPromise;
      const signatureBuf = await crypto.subtle.sign("HMAC", key, payloadBuf);
      
      const token = `${bufToBase64(payloadBuf)}.${bufToBase64(signatureBuf)}`;
      
      return respond(200, { token, expiresAt });
    }

    // --- Authenticated Middleware ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (path === "/login" && method === "POST") {
        /* Handled above */
      } else if (path === "/me" || path === "/admin/stats" || path === "/logout") {
        return respond(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.split(" ")[1];
    let authenticatedUser: User | null = null;
    let currentJti: string | null = null;

    if (token) {
      try {
        const [payloadB64, signatureB64] = token.split(".");
        if (!payloadB64 || !signatureB64) throw new Error();

        const payloadBuf = base64ToBuf(payloadB64);
        const signatureBuf = base64ToBuf(signatureB64);
        const key = await keyPromise;

        // Verify HMAC signature
        const isValid = await crypto.subtle.verify(
          "HMAC",
          key,
          signatureBuf,
          payloadBuf,
        );

        if (!isValid) throw new Error();

        const payload = JSON.parse(decoder.decode(payloadBuf));
        if (typeof payload.u !== "string" || typeof payload.exp !== "number" || typeof payload.jti !== "string") {
          throw new Error();
        }

        // Check Expiry
        if (now().getTime() >= payload.exp) throw new Error();

        // Check Revocation
        if (revokedTokens.has(payload.jti)) throw new Error();

        authenticatedUser = users.find((u) => u.username === payload.u) || null;
        currentJti = payload.jti;
        
        if (!authenticatedUser) throw new Error();
      } catch {
        // If requesting an authenticated route and token is invalid
        if (path === "/me" || path === "/admin/stats" || path === "/logout") {
          return respond(401, { error: "unauthorized" });
        }
      }
    }

    // --- Authenticated Routes ---
    if (authenticatedUser && currentJti) {
      if (path === "/me" && method === "GET") {
        return respond(200, { username: authenticatedUser.username, role: authenticatedUser.role });
      }

      if (path === "/admin/stats" && method === "GET") {
        if (authenticatedUser.role !== "admin") {
          return respond(403, { error: "forbidden" });
        }
        return respond(200, {
          users: users.length,
          admins: users.filter((u) => u.role === "admin").length,
        });
      }

      if (path === "/logout" && method === "POST") {
        revokedTokens.add(currentJti);
        return respond(204);
      }
    }

    // --- Fallthrough: 404 ---
    return respond(404, { error: "not_found" });
  };
}
