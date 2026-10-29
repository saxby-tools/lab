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

  // Memory state for revoked or active tokens
  // Map key: nonce (base64), Value: Session details
  const sessions = new Map<string, { username: string; role: Role; expiresAt: number }>();

  let cryptoKey: CryptoKey | null = null;

  async function getCryptoKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return cryptoKey;
  }

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
  }

  function base64ToArrayBuffer(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  function jsonResponse(status: number, data: any): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Helper to validate and extract user from token
    async function authenticate(): Promise<{ username: string; role: Role } | null> {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
      }

      const token = authHeader.slice(7);
      const parts = token.split(".");
      if (parts.length !== 2) return null;

      const [nonceB64, signatureB64] = parts;
      const nonceBytes = base64ToArrayBuffer(nonceB64);
      const signatureBytes = base64ToArrayBuffer(signatureB64);

      try {
        const key = await getCryptoKey();
        const isValid = await crypto.subtle.verify(
          "HMAC",
          key,
          signatureBytes,
          nonceBytes,
        );

        if (!isValid) return null;

        const session = sessions.get(nonceB64);
        if (!session) return null;

        if (now().getTime() >= session.expiresAt) {
          sessions.delete(nonceB64);
          return null;
        }

        return { username: session.username, role: session.role };
      } catch {
        return null;
      }
    }

    if (path === "/login" && req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }

      if (
        !body ||
        typeof body !== "object" ||
        typeof body.username !== "string" ||
        typeof body.password !== "string"
      ) {
        return jsonResponse(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
      const nonceB64 = arrayBufferToBase64(nonceBytes.buffer);
      const key = await getCryptoKey();
      const signatureBytes = await crypto.subtle.sign("HMAC", key, nonceBytes);
      const signatureB64 = arrayBufferToBase64(signatureBytes);

      const expiresAtDate = new Date(now().getTime() + 60 * 60 * 1000);
      sessions.set(nonceB64, {
        username: user.username,
        role: user.role,
        expiresAt: expiresAtDate.getTime(),
      });

      return jsonResponse(200, {
        token: `${nonceB64}.${signatureB64}`,
        expiresAt: expiresAtDate.toISOString(),
      });
    }

    if (path === "/me" && req.method === "GET") {
      const user = await authenticate();
      if (!user) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: user.username, role: user.role });
    }

    if (path === "/admin/stats" && req.method === "GET") {
      const user = await authenticate();
      if (!user) return jsonResponse(401, { error: "unauthorized" });
      if (user.role !== "admin") return jsonResponse(403, { error: "forbidden" });

      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && req.method === "POST") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return jsonResponse(401, { error: "unauthorized" });
      }

      const token = authHeader.slice(7);
      const nonceB64 = token.split(".")[0];

      // We must verify the token is valid before revoking to prevent arbitrary nonce deletion
      // but the prompt implies we can just revoke if provided. 
      // To strictly follow "revokes the token it was called with", we verify first.
      const user = await authenticate();
      if (!user) return jsonResponse(401, { error: "unauthorized" });

      sessions.delete(nonceB64);
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
