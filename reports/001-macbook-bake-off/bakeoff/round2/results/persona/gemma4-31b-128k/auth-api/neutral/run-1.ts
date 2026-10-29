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

  let hmacKey: CryptoKey | null = null;

  async function getHmacKey(): Promise<CryptoKey> {
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

  function toHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function createToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const expiry = new Date(now().getTime() + 60 * 60 * 1000);
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const payload = JSON.stringify({
      u: username,
      e: expiry.getTime(),
      n: nonce,
    });

    const key = await getHmacKey();
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    
    // Token format: base64(payload).hex(signature)
    const token = `${btoa(payload)}.${toHex(signature)}`;
    return { token, expiresAt: expiry.toISOString() };
  }

  async function verifyToken(tokenStr: string): Promise<{ username: string; role: Role } | null> {
    try {
      const parts = tokenStr.split(".");
      if (parts.length !== 2) return null;

      const payloadStr = atob(parts[0]);
      const signatureHex = parts[1];
      const payload = JSON.parse(payloadStr);

      if (!payload.u || !payload.e || !payload.n) return null;

      // Verify signature
      const key = await getHmacKey();
      const signatureBuf = new Uint8Array(
        signatureHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
      );

      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBuf,
        encoder.encode(payloadStr),
      );

      if (!isValid) return null;

      // Check expiration
      if (now().getTime() >= payload.e) return null;

      // Check revocation
      if (revokedNonces.has(payload.n)) return null;

      const user = users.find((u) => u.username === payload.u);
      if (!user) return null;

      return { username: user.username, role: user.role };
    } catch {
      return null;
    }
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

      const user = users.find((u) => u.username === body.username);
      if (!user || user.password !== body.password) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await createToken(user.username);
      return jsonResponse(200, { token, expiresAt });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (method === "POST" && path === "/login") {
        /* handled above */
      } else if (path === "/login") {
        return jsonResponse(404, { error: "not_found" });
      } else {
        // For non-login routes, missing token is unauthorized
        if (["/me", "/admin/stats", "/logout"].includes(path)) {
          return jsonResponse(401, { error: "unauthorized" });
        }
        return jsonResponse(404, { error: "not_found" });
      }
    }

    const token = authHeader.substring(7);
    const authUser = await verifyToken(token);

    if (!authUser) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    if (method === "GET" && path === "/me") {
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    if (method === "GET" && path === "/admin/stats") {
      if (authUser.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      const adminCount = users.filter((u) => u.role === "admin").length;
      return jsonResponse(200, { users: users.length, admins: adminCount });
    }

    if (method === "POST" && path === "/logout") {
      try {
        const payload = JSON.parse(atob(token.split(".")[0]));
        revokedNonces.add(payload.n);
      } catch {}
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
