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

  const enc = new TextEncoder();

  function toBase64Url(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(s: string): Uint8Array {
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  async function sign(data: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return new Uint8Array(sig);
  }

  function makeToken(username: string, expiry: number): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const payload = JSON.stringify({ u: username, e: expiry, n: toBase64Url(nonce) });
    return sign(enc.encode(payload)).then((sig) => {
      return toBase64Url(enc.encode(payload)) + "." + toBase64Url(sig);
    });
  }

  interface ParsedToken {
    username: string;
  }

  async function verifyToken(token: string, currentMs: number): Promise<ParsedToken | null> {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sigB64] = parts;

    // Verify signature
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = fromBase64Url(payloadB64);
    } catch {
      return null;
    }

    let expectedSig: Uint8Array;
    try {
      expectedSig = await sign(payloadBytes);
    } catch {
      return null;
    }

    let providedSig: Uint8Array;
    try {
      providedSig = fromBase64Url(sigB64);
    } catch {
      return null;
    }

    if (!constantTimeEqual(expectedSig, providedSig)) return null;

    // Parse payload
    let payload: { u?: unknown; e?: unknown; n?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      return null;
    }

    if (
      typeof payload.u !== "string" ||
      typeof payload.e !== "number" ||
      typeof payload.n !== "string"
    ) {
      return null;
    }

    // Check expiry: valid when currentMs < expiry
    if (currentMs >= payload.e) return null;

    // Check revocation
    if (revoked.has(token)) return null;

    return { username: payload.u };
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;
    const currentMs = now().getTime();

    // POST /login
    if (method === "POST" && pathname === "/login") {
      let body: unknown;
      try {
        const text = await req.text();
        body = JSON.parse(text);
      } catch {
        return json(400, { error: "invalid_request" });
      }

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return json(400, { error: "invalid_request" });
      }

      const obj = body as Record<string, unknown>;
      if (
        typeof obj.username !== "string" ||
        typeof obj.password !== "string"
      ) {
        return json(400, { error: "invalid_request" });
      }

      const username = obj.username;
      const password = obj.password;

      const user = users.find((u) => u.username === username && u.password === password);
      if (!user) {
        return json(401, { error: "invalid_credentials" });
      }

      const expiry = currentMs + 3600000;
      const expiresAt = new Date(expiry).toISOString();
      const token = await makeToken(username, expiry);

      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && pathname === "/me") {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return json(401, { error: "unauthorized" });
      }
      const token = auth.slice(7);
      if (!token) {
        return json(401, { error: "unauthorized" });
      }
      const parsed = await verifyToken(token, currentMs);
      if (!parsed) {
        return json(401, { error: "unauthorized" });
      }
      const user = users.find((u) => u.username === parsed!.username);
      if (!user) {
        return json(401, { error: "unauthorized" });
      }
      return json(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && pathname === "/admin/stats") {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return json(401, { error: "unauthorized" });
      }
      const token = auth.slice(7);
      if (!token) {
        return json(401, { error: "unauthorized" });
      }
      const parsed = await verifyToken(token, currentMs);
      if (!parsed) {
        return json(401, { error: "unauthorized" });
      }
      const user = users.find((u) => u.username === parsed!.username);
      if (!user) {
        return json(401, { error: "unauthorized" });
      }
      if (user.role !== "admin") {
        return json(403, { error: "forbidden" });
      }
      const adminCount = users.filter((u) => u.role === "admin").length;
      return json(200, { users: users.length, admins: adminCount });
    }

    // POST /logout
    if (method === "POST" && pathname === "/logout") {
      const auth = req.headers.get("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return json(401, { error: "unauthorized" });
      }
      const token = auth.slice(7);
      if (!token) {
        return json(401, { error: "unauthorized" });
      }
      const parsed = await verifyToken(token, currentMs);
      if (!parsed) {
        return json(401, { error: "unauthorized" });
      }
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    // Everything else
    return json(404, { error: "not_found" });
  };
}
