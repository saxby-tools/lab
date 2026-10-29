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

  // Pre-import the HMAC key to avoid doing it on every request
  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const jsonResponse = (status: number, body: any) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const generateToken = async (username: string, expiresAt: number) => {
    const key = await keyPromise;
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({
      u: username,
      e: expiresAt,
      n: btoa(String.fromCharCode(...nonce)),
    });
    const payloadBytes = new TextEncoder().encode(payload);
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, payloadBytes);
    const signatureBytes = new Uint8Array(signatureBuffer);
    
    const token = `${btoa(payload)}.${btoa(String.fromCharCode(...signatureBytes))}`;
    return token;
  };

  const verifyToken = async (token: string) => {
    if (!token || revokedTokens.has(token)) return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    try {
      const key = await keyPromise;
      const payloadStr = atob(parts[0]);
      const signatureStr = atob(parts[1]);
      const payloadBytes = new TextEncoder().encode(payloadStr);
      const signatureBytes = new Uint8Array(signatureStr.split("").map((c) => c.charCodeAt(0)));

      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        payloadBytes,
      );

      if (!isValid) return null;

      const payload = JSON.parse(payloadStr);
      if (now().getTime() >= payload.e) return null;

      return { username: payload.u, role: users.find((u) => u.username === payload.u)?.role };
    } catch {
      return null;
    }
  };

  return async (req: Request): Promise<Response> => {
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

      const expiryDate = new Date(now().getTime() + 3600000);
      const token = await generateToken(user.username, expiryDate.getTime());

      return jsonResponse(200, {
        token,
        expiresAt: expiryDate.toISOString(),
      });
    }

    // Authenticated routes
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const authUser = token ? await verifyToken(token) : null;

    if (!authUser) {
      // We only return 401 for authenticated routes if the token is invalid/missing
      // But we must check the path first to distinguish 404 from 401
      if (path === "/me" || path === "/admin/stats" || path === "/logout") {
        return jsonResponse(401, { error: "unauthorized" });
      }
    }

    if (method === "GET" && path === "/me") {
      return jsonResponse(200, { username: authUser!.username, role: authUser!.role });
    }

    if (method === "GET" && path === "/admin/stats") {
      if (authUser!.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      return jsonResponse(200, {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
      });
    }

    if (method === "POST" && path === "/logout") {
      if (token) revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
