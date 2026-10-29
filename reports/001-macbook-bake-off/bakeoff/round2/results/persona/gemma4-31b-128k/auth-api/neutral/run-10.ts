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
  const encoder = new TextEncoder();

  // We resolve the crypto key asynchronously. 
  // Since createAuthHandler is synchronous, we must handle the promise
  // inside the request handler or use an initialization pattern.
  let secretKey: CryptoKey | null = null;
  const keyPromise = crypto.subtle
    .importKey(
      "raw",
      encoder.encode(options.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    )
    .then((key) => {
      secretKey = key;
      return key;
    });

  const revokedTokens = new Set<string>();

  const now = () => (options.now ? options.now() : new Date());

  const jsonResponse = (data: any, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const bufToBase64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const base64ToBuf = (str: string) => {
    const bin = atob(str);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  };

  return async (req: Request): Promise<Response> => {
    // Ensure the HMAC key is imported before proceeding
    await keyPromise;
    const key = secretKey!;

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // --- Route: POST /login ---
    if (path === "/login" && method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const { username, password } = body;
      if (typeof username !== "string" || typeof password !== "string") {
        return jsonResponse({ error: "invalid_request" }, 400);
      }

      const user = options.users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return jsonResponse({ error: "invalid_credentials" }, 401);
      }

      const expiry = now().getTime() + 3600 * 1000;
      const nonce = crypto.getRandomValues(new Uint8Array(16));

      const payload = JSON.stringify({
        u: user.username,
        e: expiry,
        n: bufToBase64(nonce.buffer),
      });
      const payloadBuf = encoder.encode(payload);
      const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBuf);

      const token = `${bufToBase64(payloadBuf)}.${bufToBase64(sigBuf)}`;
      return jsonResponse(
        { token, expiresAt: new Date(expiry).toISOString() },
        200,
      );
    }

    // --- Authenticated Middleware Logic ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (path === "/login" && method === "POST") {
        /* already handled */
      } else if (path === "/me" || path === "/admin/stats" || path === "/logout") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    const token = authHeader?.split(" ")[1];
    let authenticatedUser: User | null = null;

    if (token) {
      const parts = token.split(".");
      if (parts.length === 2) {
        const [b64Payload, b64Sig] = parts;
        const payloadBuf = encoder.encode(atob(b64Payload));
        const sigBuf = base64ToBuf(b64Sig);

        const isValid = await crypto.subtle.verify("HMAC", key, sigBuf, payloadBuf);
        if (isValid) {
          try {
            const payload = JSON.parse(atob(b64Payload));
            if (now().getTime() < payload.e && !revokedTokens.has(token)) {
              authenticatedUser = options.users.find((u) => u.username === payload.u) || null;
            }
          } catch {
            // Invalid payload JSON
          }
        }
      }
    }

    if (!authenticatedUser && (path === "/me" || path === "/admin/stats" || path === "/logout")) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    // --- Authenticated Routes ---
    if (path === "/me" && method === "GET") {
      return jsonResponse({
        username: authenticatedUser!.username,
        role: authenticatedUser!.role,
      });
    }

    if (path === "/admin/stats" && method === "GET") {
      if (authenticatedUser!.role !== "admin") {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      return jsonResponse({
        users: options.users.length,
        admins: options.users.filter((u) => u.role === "admin").length,
      });
    }

    if (path === "/logout" && method === "POST") {
      if (token) revokedTokens.add(token);
      return new Response(null, { status: 204 });
    }

    // --- Everything else ---
    return jsonResponse({ error: "not_found" }, 404);
  };
}
