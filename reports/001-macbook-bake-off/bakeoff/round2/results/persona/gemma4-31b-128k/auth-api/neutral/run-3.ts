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
 * Helper to create JSON responses with the required charset.
 */
function jsonResponse(body: any, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Base64URL encoding for binary data to satisfy "visible ASCII" and "no spaces".
 */
function bufToB64Url(buf: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToStr(str: string): string {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

export function createAuthHandler(options: AuthOptions): (req: Request) => Promise<Response> {
  const { users, secret, now = () => new Date() } = options;
  const encoder = new TextEncoder();

  // State kept in memory inside the handler closure
  const revokedTokens = new Set<string>();

  // Pre-import the HMAC key for performance and correctness
  const keyPromise = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const key = await keyPromise;

    // --- Route: POST /login ---
    if (path === "/login" && method === "POST") {
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

      const user = users.find((u) => u.username === body.username);
      // Constant-time check is ideal, but these are plaintext. 
      // We ensure the error message is identical for non-existent users and wrong passwords.
      if (!user || user.password !== body.password) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      // Token logic: payload = username + expiry + nonce
      const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
      const expiryTime = expiryDate.getTime();
      const nonce = bufToB64Url(crypto.getRandomValues(new Uint8Array(16)));
      const payload = `${user.username}:${expiryTime}:${nonce}`;
      const payloadB64 = strToB64Url(payload);

      const signatureBuf = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payloadB64),
      );
      const signatureB64 = bufToB64Url(signatureBuf);

      const token = `${payloadB64}.${signatureB64}`;
      return jsonResponse({ token, expiresAt: expiryDate.toISOString() }, 200);
    }

    // --- Authenticated Route Middleware ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // If not on login, any other request requiring auth (or just being checked)
      // should be handled by the a 404 or 401. 
      // We only proceed to 401 if it's an authenticated route.
    }

    const token = authHeader?.split(" ")[1];

    // Helper to verify token and return the associated user
    const verifyToken = async (): Promise<{ user: User | null; error?: { status: number; msg: string } }> => {
      if (!token) return { user: null, error: { status: 401, msg: "unauthorized" } };
      if (revokedTokens.has(token)) return { user: null, error: { status: 401, msg: "unauthorized" } };

      const parts = token.split(".");
      if (parts.length !== 2) return { user: null, error: { status: 401, msg: "unauthorized" } };

      const [payloadB64, signatureB64] = parts;
      const expectedSigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
      const expectedSigB64 = bufToB64Url(expectedSigBuf);

      if (signatureB64 !== expectedSigB64) {
        return { user: null, error: { status: 401, msg: "unauthorized" } };
      }

      try {
        const payload = b64UrlToStr(payloadB64);
        const [username, expiryStr, _nonce] = payload.split(":");
        const expiryTime = parseInt(expiryStr, 10);

        if (isNaN(expiryTime) || now().getTime() >= expiryTime) {
          return { user: null, error: { status: 401, msg: "unauthorized" } };
        }

        const user = users.find((u) => u.username === username);
        if (!user) return { user: null, error: { status: 401, msg: "unauthorized" } };

        return { user };
      } catch {
        return { user: null, error: { status: 401, msg: "unauthorized" } };
      }
    };

    // --- Authenticated Routes ---
    if (path === "/me" && method === "GET") {
      const { user, error } = await verifyToken();
      if (error) return jsonResponse({ error: error.msg }, error.status);
      return jsonResponse({ username: user!.username, role: user!.role }, 200);
    }

    if (path === "/admin/stats" && method === "GET") {
      const { user, error } = await verifyToken();
      if (error) return jsonResponse({ error: error.msg }, error.status);
      if (user!.role !== "admin") return jsonResponse({ error: "forbidden" }, 403);

      return jsonResponse({
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      }, 200);
    }

    if (path === "/logout" && method === "POST") {
      const { user, error } = await verifyToken();
      if (error) return jsonResponse({ error: error.msg }, error.status);

      revokedTokens.add(token!);
      return new Response(null, { status: 204 });
    }

    // --- Everything Else ---
    return jsonResponse({ error: "not_found" }, 404);
  };
}

