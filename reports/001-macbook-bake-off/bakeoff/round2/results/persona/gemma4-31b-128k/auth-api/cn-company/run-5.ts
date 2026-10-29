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
  const revokedNonces = new Set<string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let cryptoKey: CryptoKey | null = null;

  async function getCryptoKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return cryptoKey;
  }

  function jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function toB64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
  }

  function fromB64(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  async function verifyToken(token: string): Promise<{ user: User; nonce: string } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;
    const payloadBytes = fromB64(payloadB64);
    const signatureBytes = fromB64(sigB64);
    const payloadStr = decoder.decode(payloadBytes);

    const key = await getCryptoKey();
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      payloadBytes,
    );

    if (!isValid) return null;

    try {
      const { username, expiry, nonce } = JSON.parse(payloadStr);
      if (now().getTime() >= expiry) return null;
      if (revokedNonces.has(nonce)) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { user, nonce };
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    if (method === "POST" && pathname === "/login") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        typeof body.username !== "string" ||
        typeof body.password !== "string",
      ) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      const nonce = crypto.randomUUID();
      const expiryTime = now().getTime() + 3600000;
      const payloadObj = { username: user.username, expiry: expiryTime, nonce };
      const payloadStr = JSON.stringify(payloadObj);
      const payloadBytes = encoder.encode(payloadStr);

      const key = await getCryptoKey();
      const sigBytes = await crypto.subtle.sign("HMAC", key, payloadBytes);

      const token = `${toB64(payloadBytes)}.${toB64(new Uint8Array(sigBytes))}`;
      const expiresAt = new Date(expiryTime).toISOString();

      return jsonResponse({ token, expiresAt }, 200);
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    let tokenValue: string | null = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      tokenValue = authHeader.substring(7);
    }

    if (!tokenValue) {
      // Handle 404 before returning 401 for authenticated routes
      if (!(method === "GET" && (pathname === "/me" || pathname === "/admin/stats")) &&
          !(method === "POST" && pathname === "/logout")) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const authContext = await verifyToken(tokenValue);
    if (!authContext) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const { user, nonce } = authContext;

    if (method === "GET" && pathname === "/me") {
      return jsonResponse({ username: user.username, role: user.role }, 200);
    }

    if (method === "GET" && pathname === "/admin/stats") {
      if (user.role !== "admin") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      }, 200);
    }

    if (method === "POST" && pathname === "/logout") {
      revokedNonces.add(nonce);
      return new Response(null, { status: 204 });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };
}

