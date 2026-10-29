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

  // Cache the CryptoKey to avoid re-importing on every request
  let cryptoKey: CryptoKey | null = null;

  async function getSecretKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    const encoder = new TextEncoder();
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return cryptoKey;
  }

  function jsonResponse(status: number, body: any): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }

  function base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function generateToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const expiryDate = new Date(now().getTime() + 60 * 60 * 1000);
    const expiresAt = expiryDate.toISOString();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const nonceStr = arrayBufferToBase64(nonce);

    const payload = `${username}|${expiresAt}|${nonceStr}`;
    const encoder = new TextEncoder();
    const key = await getSecretKey();
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    const token = `${btoa(payload)}.${arrayBufferToBase64(signature)}`;
    return { token, expiresAt };
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const payloadStr = atob(parts[0]);
      const signatureBuf = base64ToArrayBuffer(parts[1]);
      const encoder = new TextEncoder();

      const key = await getSecretKey();
      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBuf,
        encoder.encode(payloadStr),
      );

      if (!isValid) return null;

      const [username, expiresAtStr] = payloadStr.split("|");
      const expiresAt = new Date(expiresAtStr);

      if (now().getTime() >= expiresAt.getTime()) return null;

      const user = users.find((u) => u.username === username);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Route: POST /login
    if (path === "/login" && req.method === "POST") {
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

      const { token, expiresAt } = await generateToken(user.username);
      return jsonResponse(200, { token, expiresAt });
    }

    // Authenticated routes middleware
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
    const authUser = token ? await verifyToken(token) : null;

    if (path === "/me" && req.method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    if (path === "/admin/stats" && req.method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      if (authUser.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && req.method === "POST") {
      if (!authUser || !token) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // Default 404
    return jsonResponse(404, { error: "not_found" });
  };
}
