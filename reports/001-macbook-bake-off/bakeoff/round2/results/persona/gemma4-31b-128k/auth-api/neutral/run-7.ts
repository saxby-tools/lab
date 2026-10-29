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
  const revokedTokens = new Set<string>();
  const encoder = new TextEncoder();
  const nowFn = options.now || (() => new Date());

  let cryptoKey: CryptoKey | null = null;

  async function getKey(): Promise<CryptoKey> {
    if (cryptoKey) return cryptoKey;
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return cryptoKey;
  }

  function bufferToBase64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  function base64ToBuffer(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function jsonResponse(data: any, status = 200) {
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

      const user = options.users.find(
        (u) => u.username === body.username && u.password === body.password,
      );

      if (!user) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      const timestamp = nowFn().getTime();
      const nonce = bufferToBase64(crypto.getRandomValues(new Uint8Array(16)));
      const payload = JSON.stringify({ u: user.username, t: timestamp, n: nonce });
      
      const key = await getKey();
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      
      const token = `${btoa(payload)}.${bufferToBase64(signature)}`;
      const expiresAt = new Date(timestamp + 3600000).toISOString();

      return jsonResponse({ token, expiresAt });
    }

    // Authenticated Route Logic
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (method === "POST" && path === "/login") {
        // Handled above, but logically separated
      } else if (
        (method === "GET" && (path === "/me" || path === "/admin/stats")) ||
        (method === "POST" && path === "/logout")
      ) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    const token = authHeader?.split(" ")[1];
    if (!token) {
      if ((method === "GET" && (path === "/me" || path === "/admin/stats")) ||
          (method === "POST" && path === "/logout")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    // Validate Token
    let authenticatedUser: User | null = null;
    if (token) {
      const parts = token.split(".");
      if (parts.length === 2) {
        const [payloadB64, sigB64] = parts;
        try {
          const payload = atob(payloadB64);
          const sigBuffer = base64ToBuffer(sigB64);
          const key = await getKey();

          const isValid = await crypto.subtle.verify(
            "HMAC",
            key,
            sigBuffer,
            encoder.encode(payload),
          );

          if (isValid) {
            const data = JSON.parse(payload);
            const currentT = nowFn().getTime();

            if (!revokedTokens.has(token) && currentT < data.t + 3600000) {
              authenticatedUser = options.users.find((u) => u.username === data.u) || null;
            }
          }
        } catch {
          // Invalid format or decoding error
        }
      }
    }

    if (!authenticatedUser) {
      if ((method === "GET" && (path === "/me" || path === "/admin/stats")) ||
          (method === "POST" && path === "/logout")) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    // Route Handlers
    if (method === "GET" && path === "/me" && authenticatedUser) {
      return jsonResponse({
        username: authenticatedUser.username,
        role: authenticatedUser.role,
      });
    }

    if (method === "GET" && path === "/admin/stats" && authenticatedUser) {
      if (authenticatedUser.role !== "admin") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({
        users: options.users.length,
        admins: options.users.filter((u) => u.role === "admin").length,
      });
    }

    if (method === "POST" && path === "/logout" && token && authenticatedUser) {
      revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };
}
