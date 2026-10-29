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

  // Pre-calculate the CryptoKey for HMAC to avoid repeated imports
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

  const bufferToB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64ToBuffer = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    // --- Authentication Middleware ---
    const authenticate = async () => {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new Error("unauthorized");
      }

      const token = authHeader.substring(7);
      if (revokedTokens.has(token)) {
        throw new Error("unauthorized");
      }

      const parts = token.split(".");
      if (parts.length !== 2) {
        throw new Error("unauthorized");
      }

      const [payloadB64, signatureB64] = parts;
      const key = await keyPromise;

      // Verify Signature
      const payloadBytes = b64ToBuffer(payloadB64);
      const signatureBytes = b64ToBuffer(signatureB64);
      const isValid = await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        payloadBytes,
      );

      if (!isValid) {
        throw new Error("unauthorized");
      }

      // Parse and Validate Payload
      const payloadStr = new TextDecoder().decode(payloadBytes);
      const [username, expiresAtStr, _nonce] = payloadStr.split("|");
      const expiresAt = parseInt(expiresAtStr, 10);

      if (isNaN(expiresAt) || now().getTime() >= expiresAt) {
        throw new Error("unauthorized");
      }

      const user = users.find((u) => u.username === username);
      if (!user) {
        throw new Error("unauthorized");
      }

      return { user, token };
    };

    try {
      // --- Route Handling ---
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

        // Token Generation
        const expiresAtDate = new Date(now().getTime() + 3600000);
        const expiresAtTs = expiresAtDate.getTime();
        const nonce = new Uint8Array(16);
        crypto.getRandomValues(nonce);
        const nonceB64 = bufferToB64(nonce);

        const payload = `${user.username}|${expiresAtTs}|${nonceB64}`;
        const payloadBytes = new TextEncoder().encode(payload);
        const key = await keyPromise;
        const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);

        const token = `${bufferToB64(payloadBytes)}.${bufferToB64(signature)}`;

        return jsonResponse(200, {
          token,
          expiresAt: expiresAtDate.toISOString(),
        });
      }

      // All subsequent routes require authentication
      const { user, token } = await authenticate();

      if (method === "GET" && path === "/me") {
        return jsonResponse(200, { username: user.username, role: user.role });
      }

      if (method === "GET" && path === "/admin/stats") {
        if (user.role !== "admin") {
          return jsonResponse(403, { error: "forbidden" });
        }
        return jsonResponse(200, {
          users: users.length,
          admins: users.filter((u) => u.role === "admin").length,
        });
      }

      if (method === "POST" && path === "/logout") {
        revokedTokens.add(token);
        return new Response(null, { status: 204 });
      }

      // 404 for any other path/method
      return jsonResponse(404, { error: "not_found" });

    } catch (e: any) {
      if (e.message === "unauthorized") {
        return jsonResponse(401, { error: "unauthorized" });
      }
      // Fallback for unexpected errors or 404s if they slipped through
      if (method !== "POST" || path !== "/login") {
        return jsonResponse(404, { error: "not_found" });
      }
      return jsonResponse(500, { error: "internal_server_error" });
    }
  };
}
