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

  // Pre-calculate the CryptoKey from the secret for performance
  // We'll handle the async key import inside the handler or via a promise
  const keyPromise = crypto
    .subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );

  async function jsonResponse(status: number, body?: unknown): Promise<Response> {
    const headers = new Headers();
    if (body !== undefined) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    return new Response(body ? JSON.stringify(body) : undefined, {
      status,
      headers,
    });
  }

  function base64UrlEncode(buffer: ArrayBuffer): string {
    const binary = String.fromCharCode(...new Uint8Array(buffer));
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function base64UrlDecode(str: string): Uint8Array {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function generateToken(username: string, expiresAt: Date): Promise<string> {
    const key = await keyPromise;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({
      u: username,
      e: expiresAt.getTime(),
      n: base64UrlEncode(nonce),
    });
    const payloadUint8 = encoder.encode(payload);
    const signature = await crypto.subtle.sign("HMAC", key, payloadUint8);
    
    return `${base64UrlEncode(payloadUint8)}.${base64UrlEncode(signature)}`;
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const key = await keyPromise;
      const payloadUint8 = base64UrlDecode(parts[0]);
      const signatureUint8 = base64UrlDecode(parts[1]);

      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureUint8,
        payloadUint8,
      );

      if (!isValid) return null;

      const payload = JSON.parse(new TextDecoder().decode(payloadUint8));
      if (typeof payload.u !== "string" || typeof payload.e !== "number") return null;

      if (now().getTime() >= payload.e) return null;

      const user = users.find((u) => u.username === payload.u);
      if (!user) return null;

      return { username: user.username, role: user.role };
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
        return jsonResponse(400, { error: "invalid_request" });
      }

      if (!body || typeof body !== "object" || typeof body.username !== "string" || typeof body.password !== "string") {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username && u.password === body.password);
      if (!user) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const expiresAt = new Date(now().getTime() + 60 * 60 * 1000);
      const token = await generateToken(user.username, expiresAt);

      return jsonResponse(200, {
        token,
        expiresAt: expiresAt.toISOString(),
      });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authUser = token ? await verifyToken(token) : null;

    if (method === "GET" && pathname === "/me") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    if (method === "GET" && pathname === "/admin/stats") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      if (authUser.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (method === "POST" && pathname === "/logout") {
      if (!authUser || !token) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return jsonResponse(204);
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
