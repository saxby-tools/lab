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
  const { users, secret } = options;
  const now = options.now ?? (() => new Date());
  const revoked = new Set<string>();

  function base64urlEncode(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlDecode(str: string): Uint8Array {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const binary = atob(b64 + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function computeHmac(message: string, key: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(message),
    );
    return base64urlEncode(sig);
  }

  async function generateToken(username: string, expISO: string): Promise<string> {
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonce = base64urlEncode(nonceBytes.buffer);
    const payloadJson = JSON.stringify({ u: username, e: expISO, n: nonce });
    const payload = base64urlEncode(new TextEncoder().encode(payloadJson));
    const sig = await computeHmac(payload, secret);
    return `${payload}.${sig}`;
  }

  async function verifyToken(
    token: string,
  ): Promise<{ username: string; role: Role } | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payload, sig] = parts;

    const expectedSig = await computeHmac(payload, secret);

    // Constant-time comparison to avoid timing side-channels
    if (sig.length !== expectedSig.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    }
    if (diff !== 0) return null;

    let data: { u: string; e: string; n: string };
    try {
      const payloadBytes = base64urlDecode(payload);
      const payloadStr = new TextDecoder().decode(payloadBytes);
      data = JSON.parse(payloadStr);
    } catch {
      return null;
    }

    // Expiration: valid strictly before exp; at or after exp it is expired
    const exp = new Date(data.e).getTime();
    if (Number.isNaN(exp) || now().getTime() >= exp) return null;

    // Revocation
    if (revoked.has(token)) return null;

    // User must exist
    const user = users.find((u) => u.username === data.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  async function extractBearer(req: Request): Promise<string | null> {
    const auth = req.headers.get("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    if (token.length === 0) return null;
    return token;
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && pathname === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_request" });
      }

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as Record<string, unknown>).username !== "string" ||
        typeof (body as Record<string, unknown>).password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }

      const { username, password } = body as {
        username: string;
        password: string;
      };

      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return json(401, { error: "invalid_credentials" });
      }

      const issueTime = now();
      const expTime = new Date(issueTime.getTime() + 60 * 60 * 1000);
      const expISO = expTime.toISOString();
      const token = await generateToken(username, expISO);

      return json(200, { token, expiresAt: expISO });
    }

    // GET /me
    if (method === "GET" && pathname === "/me") {
      const token = await extractBearer(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && pathname === "/admin/stats") {
      const token = await extractBearer(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      if (user.role !== "admin") return json(403, { error: "forbidden" });
      const admins = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && pathname === "/logout") {
      const token = await extractBearer(req);
      if (token === null) return json(401, { error: "unauthorized" });
      const user = await verifyToken(token);
      if (!user) return json(401, { error: "unauthorized" });
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return json(404, { error: "not_found" });
  };
}
