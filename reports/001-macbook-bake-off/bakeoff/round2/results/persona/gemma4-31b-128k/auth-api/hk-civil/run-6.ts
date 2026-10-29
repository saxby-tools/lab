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

  // Helpers for Base64 conversion without external dependencies
  const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  const fromB64 = (str: string): Uint8Array => {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const jsonResponse = (data: any, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    // 1. Handle /login (Public)
    if (path === "/login" && method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      if (
        !body ||
        typeof body !== "object" ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      const currentTime = now();
      const expiryDate = new Date(currentTime.getTime() + 3600000);
      const expiryTimestamp = expiryDate.getTime();

      // Generate a unique nonce for the token
      const nonce = toB64(crypto.getRandomValues(new Uint8Array(16)));
      const payload = JSON.stringify({
        u: user.username,
        e: expiryTimestamp,
        j: nonce,
      });

      const payloadB64 = toB64(encoder.encode(payload));
      const key = await getKey();
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payloadB64),
      );
      const token = `${payloadB64}.${toB64(new Uint8Array(signature))}`;

      return jsonResponse(
        { token, expiresAt: expiryDate.toISOString() },
        200,
      );
    }

    // 2. Authenticated Middleware
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (path === "/login" && method === "POST") {
        /* Handled above */
      } else if (path === "/me" || path === "/admin/stats" || path === "/logout") {
        return jsonResponse({ error: "unauthorized" }, 401);
      } else {
        return jsonResponse({ error: "not_found" }, 404);
      }
    }

    const token = authHeader.substring(7);
    const parts = token.split(".");

    if (parts.length !== 2) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const [payloadB64, signatureB64] = parts;
    const key = await getKey();
    const signatureBytes = fromB64(signatureB64);

    const isValidSig = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      encoder.encode(payloadB64),
    );

    if (!isValidSig) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const payloadStr = new TextDecoder().decode(fromB64(payloadB64));
    let payload;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    if (now().getTime() >= payload.e || revokedTokens.has(token)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const authenticatedUser = users.find((u) => u.username === payload.u);
    if (!authenticatedUser) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    // 3. Authenticated Routes
    if (path === "/me" && method === "GET") {
      return jsonResponse({
        username: authenticatedUser.username,
        role: authenticatedUser.role,
      });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (authenticatedUser.role !== "admin") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };
}
