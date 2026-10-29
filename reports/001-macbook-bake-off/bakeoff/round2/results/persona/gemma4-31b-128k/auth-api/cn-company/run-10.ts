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
  let cachedKey: CryptoKey | null = null;

  const encoder = new TextEncoder();

  async function getCryptoKey() {
    if (cachedKey) return cachedKey;
    cachedKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return cachedKey;
  }

  function bufferToBase64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  function base64ToBuffer(str: string): Uint8Array {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function generateToken(username: string): Promise<string> {
    const key = await getCryptoKey();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({
      u: username,
      t: now().getTime(),
      n: bufferToBase64(nonce),
    });
    const payloadB64 = btoa(payload);
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payloadB64),
    );
    return `${payloadB64}.${bufferToBase64(signature)}`;
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    const key = await getCryptoKey();

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64ToBuffer(signatureB64),
      encoder.encode(payloadB64),
    );

    if (!isValid) return null;

    try {
      const payload = JSON.parse(atob(payloadB64));
      const expiryTime = payload.t + 3600 * 1000;
      if (now().getTime() >= expiryTime) return null;

      const user = users.find((u) => u.username === payload.u);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
  }

  function jsonResponse(status: number, data: any) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> {
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

      const user = users.find((u) => u.username === body.username && u.password === body.password);
      if (!user) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const token = await generateToken(user.username);
      const expiresAt = new Date(now().getTime() + 3600 * 1000).toISOString();
      return jsonResponse(200, { token, expiresAt });
    }

    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authUser = token ? await verifyToken(token) : null;

    if (!authUser) {
      if (method === "GET" && (path === "/me" || path === "/admin/stats") || (method === "POST" && path === "/logout")) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (method === "GET" && path === "/me") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    if (method === "GET" && path === "/admin/stats") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      if (authUser.role !== "admin") return jsonResponse(403, { error: "forbidden" });
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (method === "POST" && path === "/logout") {
      if (!authUser || !token) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
