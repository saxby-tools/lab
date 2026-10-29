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

  // Cache the CryptoKey to avoid re-importing on every request
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = () => {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return keyPromise;
  };

  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const signToken = async (payload: string) => {
    const key = await getKey();
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload),
    );
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const payloadB64 = btoa(payload);
    return `${payloadB64}.${signatureB64}`;
  };

  const verifyToken = async (token: string) => {
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const payload = atob(payloadB64);
    const [username, expiryStr, nonce] = payload.split("|");

    if (!username || !expiryStr || !nonce) return null;

    // Re-verify signature
    const key = await getKey();
    const expectedSignature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload),
    );
    const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(expectedSignature)));

    if (signatureB64 !== expectedB64) return null;

    // Check expiry
    const expiry = new Date(expiryStr);
    if (now() >= expiry) return null;

    const user = users.find((u) => u.username === username);
    return user ? { user, token } : null;
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
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

      const expiresAt = new Date(now().getTime() + 60 * 60 * 1000);
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const payload = `${user.username}|${expiresAt.toISOString()}|${nonce}`;
      const token = await signToken(payload);

      return jsonResponse(200, { token, expiresAt: expiresAt.toISOString() });
    }

    // Authenticated routes middleware logic
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (method === "POST" && path === "/login") {
        /* handled above */
      } else if (
        (method === "GET" && path === "/me") ||
        (method === "GET" && path === "/admin/stats") ||
        (method === "POST" && path === "/logout")
      ) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.split(" ")[1];
    const authContext = token ? await verifyToken(token) : null;

    if (!authContext && (
        (method === "GET" && path === "/me") ||
        (method === "GET" && path === "/admin/stats") ||
        (method === "POST" && path === "/logout")
      )) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    if (method === "GET" && path === "/me") {
      const { user } = authContext!;
      return jsonResponse(200, { username: user.username, role: user.role });
    }

    if (method === "GET" && path === "/admin/stats") {
      const { user } = authContext!;
      if (user.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (method === "POST" && path === "/logout") {
      const { token: tokenToRevoke } = authContext!;
      revokedTokens.add(tokenToRevoke);
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
