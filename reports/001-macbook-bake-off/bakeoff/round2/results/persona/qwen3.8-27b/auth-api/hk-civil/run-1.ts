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

  // In-memory revoked token set (no timers – checked lazily)
  const revoked = new Set<string>();

  // ── helpers ──────────────────────────────────────────────────

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  async function hmac(payload: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    return new Uint8Array(sig);
  }

  function toB64Url(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64Url(s: string): Uint8Array {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ctEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── token utilities ─────────────────────────────────────────

  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const issuedAt = now().getTime();
    const payloadStr = JSON.stringify({
      u: username,
      t: issuedAt,
      n: toB64Url(nonce),
    });
    const payloadEnc = toB64Url(enc.encode(payloadStr));
    const sig = await hmac(payloadStr);
    const sigEnc = toB64Url(sig);
    const token = payloadEnc + "." + sigEnc;
    const expiresAt = new Date(issuedAt + 3_600_000).toISOString();
    return { token, expiresAt };
  }

  interface Verified {
    username: string;
  }

  async function verifyToken(raw: string): Promise<Verified | null> {
    // structural check: exactly two dot-separated segments
    const dotIdx = raw.indexOf(".");
    if (dotIdx === -1) return null;
    const payloadEnc = raw.slice(0, dotIdx);
    const sigEnc = raw.slice(dotIdx + 1);
    if (!payloadEnc || !sigEnc) return null;

    // decode payload
    let payloadStr: string;
    try {
      payloadStr = dec.decode(fromB64Url(payloadEnc));
    } catch {
      return null;
    }

    // verify HMAC (constant-time)
    const expected = toB64Url(await hmac(payloadStr));
    if (!ctEqual(sigEnc, expected)) return null;

    // parse payload
    let obj: unknown;
    try {
      obj = JSON.parse(payloadStr);
    } catch {
      return null;
    }
    if (
      obj === null || typeof obj !== "object" || Array.isArray(obj)
    ) return null;

    const rec = obj as Record<string, unknown>;
    if (
      typeof rec.u !== "string" ||
      typeof rec.t !== "number" ||
      typeof rec.n !== "string" ||
      Number.isNaN(rec.t)
    ) return null;

    // expiry – token is valid until exactly one hour after issuance
    if (now().getTime() >= rec.t + 3_600_000) return null;

    // revocation
    if (revoked.has(raw)) return null;

    // user must still exist in the fixed list
    const user = users.find((u) => u.username === rec.u);
    if (!user) return null;

    return { username: user.username };
  }

  // ── handler ──────────────────────────────────────────────────

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (path === "/login" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return json({ error: "invalid_request" }, 400);
      }

      const obj = body as Record<string, unknown>;
      const username = obj["username"];
      const password = obj["password"];

      if (typeof username !== "string" || typeof password !== "string") {
        return json({ error: "invalid_request" }, 400);
      }

      // constant user + password check – same response regardless of which fails
      const user = users.find((u) => u.username === username);
      if (!user || user.password !== password) {
        return json({ error: "invalid_credentials" }, 401);
      }

      const { token, expiresAt } = await issueToken(user.username);
      return json({ token, expiresAt });
    }

    // Authenticated routes
    if (
      (path === "/me" && method === "GET") ||
      (path === "/admin/stats" && method === "GET") ||
      (path === "/logout" && method === "POST")
    ) {
      const auth = req.headers.get("Authorization");
      if (auth === null || !auth.startsWith("Bearer ")) {
        return json({ error: "unauthorized" }, 401);
      }

      const token = auth.slice(7);
      if (token === "") {
        return json({ error: "unauthorized" }, 401);
      }

      const verified = await verifyToken(token);
      if (!verified) {
        return json({ error: "unauthorized" }, 401);
      }

      const user = users.find((u) => u.username === verified.username)!;

      if (path === "/me") {
        return json({ username: user.username, role: user.role });
      }

      if (path === "/admin/stats") {
        if (user.role !== "admin") {
          return json({ error: "forbidden" }, 403);
        }
        const admins = users.filter((u) => u.role === "admin").length;
        return json({ users: users.length, admins });
      }

      // POST /logout
      revoked.add(token);
      return new Response(null, { status: 204 });
    }

    // everything else
    return json({ error: "not_found" }, 404);
  }

  return handle;
}
