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

  // State maintained inside the handler closure
  const revokedTokens = new Set<string>();
  let cryptoKey: CryptoKey | null = null;

  const encoder = new TextEncoder();

  async function getCryptoKey(): Promise<CryptoKey> {
    if (!cryptoKey) {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return cryptoKey;
  }

  async function createToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const timestamp = now().getTime();
    const expiresAtDate = new Date(timestamp + 3600000);
    const expiresAtStr = expiresAtDate.toISOString();

    // Nonce ensures different tokens for same user at same instant
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const payload = `${username}:${timestamp}:${nonce}`;
    const payloadB64 = btoa(payload);
    
    const key = await getCryptoKey();
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

    return {
      token: `${payloadB64}.${signatureB64}`,
      expiresAt: expiresAtStr,
    };
  }

  async function verifyToken(token: string): Promise<{ username: string; role: Role } | null> {
    if (revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, signatureB64] = parts;
    let payload: string;
    try {
      payload = atob(payloadB64);
    } catch {
      return null;
    }

    const key = await getCryptoKey();
    const signatureBuf = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuf,
      encoder.encode(payload),
    );

    if (!isValid) return null;

    const [username, timestampStr] = payload.split(":");
    const timestamp = parseInt(timestampStr, 10);
    
    if (isNaN(timestamp) || now().getTime() >= timestamp + 3600000) {
      return null;
    }

    const user = users.find((u) => u.username === username);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function jsonResponse(status: number, body: any) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/login" && req.method === "POST") {
      let body: any;
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

      const { token, expiresAt } = await createToken(user.username);
      return jsonResponse(200, { token, expiresAt });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (pathname === "/login" && req.method === "POST") {
        // handled above, but just in case
      } else if (["/me", "/admin/stats", "/logout"].includes(pathname)) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    const token = authHeader?.split(" ")[1];
    const authUser = token ? await verifyToken(token) : null;

    if (!authUser || !token) {
      if (["/me", "/admin/stats", "/logout"].includes(pathname)) {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (pathname === "/me" && req.method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: authUser.username, role: authUser.role });
    }

    if (pathname === "/admin/stats" && req.method === "GET") {
      if (!authUser) return jsonResponse(401, { error: "unauthorized" });
      if (authUser.role !== "admin") return jsonResponse(403, { error: "forbidden" });
      
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (pathname === "/logout" && req.method === "POST") {
      if (!authUser || !token) return jsonResponse(401, { error: "unauthorized" });
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
