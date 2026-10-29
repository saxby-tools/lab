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
  const now: () => Date = options.now ?? (() => new Date());

  // Tracks every issued, non-revoked token id
  const liveTokenIds = new Set<string>();

  // ── helpers ──────────────────────────────────────────────────────────

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function randomId(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return b64url(buf);
  }

  function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array | null {
    try {
      let padded = s.replace(/-/g, "+").replace(/_/g, "/");
      while (padded.length % 4 !== 0) padded += "=";
      const bin = atob(padded);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function hmac(data: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return new Uint8Array(sig);
  }

  function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // ── token issue / validate ───────────────────────────────────────────

  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const id = randomId();
    const exp = now().getTime() + 60 * 60 * 1000;
    const expiresAt = new Date(exp).toISOString();

    const payloadStr = JSON.stringify({ id, username, exp });
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const sig = await hmac(payloadBytes);

    const token = `${b64url(payloadBytes)}.${b64url(sig)}`;
    liveTokenIds.add(id);

    return { token, expiresAt };
  }

  async function validateToken(raw: string): Promise<User | null> {
    const dot = raw.indexOf(".");
    if (dot === -1) return null;

    const payloadB64 = raw.slice(0, dot);
    const sigB64 = raw.slice(dot + 1);

    const payloadBytes = b64urlDecode(payloadB64);
    if (!payloadBytes) return null;

    const expectedSig = await hmac(payloadBytes);
    const gotSig = b64urlDecode(sigB64);
    if (!gotSig || !constantTimeEqual(expectedSig, gotSig)) return null;

    let payload: { id?: string; username?: string; exp?: number };
    try {
      payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    } catch {
      return null;
    }

    if (
      typeof payload.id !== "string" ||
      typeof payload.username !== "string" ||
      typeof payload.exp !== "number"
    ) return null;

    // revocation
    if (!liveTokenIds.has(payload.id)) return null;

    // expiry – valid until exactly 1 h; at that instant it is expired
    if (now().getTime() >= payload.exp) return null;

    const user = users.find((u) => u.username === payload.username);
    return user ?? null;
  }

  function bearerToken(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (h === null || !h.startsWith("Bearer ")) return null;
    const tok = h.slice(7);
    if (tok.length === 0 || /\s/.test(tok)) return null;
    return tok;
  }

  // ── routes ───────────────────────────────────────────────────────────

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body)
      ) {
        return jsonResponse(400, { error: "invalid_request" });
      }
      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return jsonResponse(400, { error: "invalid_request" });
      }
      const user = users.find(
        (u) => u.username === obj.username && u.password === obj.password,
      );
      if (!user) {
        return jsonResponse(401, { error: "invalid_credentials" });
      }
      const { token, expiresAt } = await issueToken(user.username);
      return jsonResponse(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const tok = bearerToken(req);
      if (tok === null) return jsonResponse(401, { error: "unauthorized" });
      const user = await validateToken(tok);
      if (!user) return jsonResponse(401, { error: "unauthorized" });
      return jsonResponse(200, { username: user.username, role: user.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const tok = bearerToken(req);
      if (tok === null) return jsonResponse(401, { error: "unauthorized" });
      const user = await validateToken(tok);
      if (!user) return jsonResponse(401, { error: "unauthorized" });
      if (user.role !== "admin") {
        return jsonResponse(403, { error: "forbidden" });
      }
      const admins = users.filter((u) => u.role === "admin").length;
      return jsonResponse(200, { users: users.length, admins });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const tok = bearerToken(req);
      if (tok === null) return jsonResponse(401, { error: "unauthorized" });
      const user = await validateToken(tok);
      if (!user) return jsonResponse(401, { error: "unauthorized" });

      // revoke: extract id and remove from live set
      const dot = tok.indexOf(".");
      const payloadBytes = b64urlDecode(tok.slice(0, dot));
      if (payloadBytes) {
        try {
          const p = JSON.parse(new TextDecoder().decode(payloadBytes));
          if (typeof p.id === "string") liveTokenIds.delete(p.id);
        } catch {
          /* already validated above; defensive */
        }
      }

      return new Response(null, { status: 204 });
    }

    // everything else
    return jsonResponse(404, { error: "not_found" });
  }

  return handle;
}
