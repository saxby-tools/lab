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
  const clock = options.now ?? (() => new Date());

  const revokedTokens = new Set<string>();
  const adminCount = users.filter((u) => u.role === "admin").length;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const HOUR_MS = 3_600_000;

  // ── helpers ──────────────────────────────────────────────────────────

  function b64urlEncode(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s: string): Uint8Array | null {
    if (s.length === 0 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    try {
      const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  async function hmacKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── token logic ──────────────────────────────────────────────────────

  async function issueToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const key = await hmacKey();
    const nowMs = clock().getTime();
    const expiresAtMs = nowMs + HOUR_MS;

    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonce = b64urlEncode(nonceBytes);

    const payloadObj = { u: username, i: nowMs, n: nonce };
    const payloadBytes = encoder.encode(JSON.stringify(payloadObj));
    const payloadB64 = b64urlEncode(payloadBytes);

    const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
    const sigB64 = b64urlEncode(new Uint8Array(sig));

    return {
      token: `${payloadB64}.${sigB64}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async function verifyToken(raw: string): Promise<{ username: string; role: Role } | null> {
    if (revokedTokens.has(raw)) return null;

    const dot = raw.indexOf(".");
    if (dot <= 0 || dot === raw.length - 1) return null;

    const payloadBytes = b64urlDecode(raw.slice(0, dot));
    if (!payloadBytes) return null;

    const sigBytes = b64urlDecode(raw.slice(dot + 1));
    if (!sigBytes) return null;

    const key = await hmacKey();
    let ok = false;
    try {
      ok = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
    } catch {
      return null;
    }
    if (!ok) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(payloadBytes));
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.u !== "string" || typeof p.i !== "number" || typeof p.n !== "string") return null;

    // expired at or after iat + 1 hour
    if (clock().getTime() >= p.i + HOUR_MS) return null;

    const user = users.find((u) => u.username === p.u);
    if (!user) return null;

    return { username: user.username, role: user.role };
  }

  function bearer(req: Request): string | null {
    const h = req.headers.get("Authorization");
    if (!h || !h.startsWith("Bearer ")) return null;
    const t = h.slice(7);
    if (t.length === 0 || t.includes(" ")) return null;
    return t;
  }

  // ── handler ───────────────────────────────────────────────────────────

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login
    if (method === "POST" && path === "/login") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid_request" });
      }

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json(400, { error: "invalid_request" });
      }

      const obj = body as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json(400, { error: "invalid_request" });
      }

      const user = users.find((u) => u.username === obj.username);
      if (!user || user.password !== obj.password) {
        return json(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await issueToken(obj.username);
      return json(200, { token, expiresAt });
    }

    // GET /me
    if (method === "GET" && path === "/me") {
      const raw = bearer(req);
      if (!raw) return json(401, { error: "unauthorized" });
      const info = await verifyToken(raw);
      if (!info) return json(401, { error: "unauthorized" });
      return json(200, { username: info.username, role: info.role });
    }

    // GET /admin/stats
    if (method === "GET" && path === "/admin/stats") {
      const raw = bearer(req);
      if (!raw) return json(401, { error: "unauthorized" });
      const info = await verifyToken(raw);
      if (!info) return json(401, { error: "unauthorized" });
      if (info.role !== "admin") return json(403, { error: "forbidden" });
      return json(200, { users: users.length, admins: adminCount });
    }

    // POST /logout
    if (method === "POST" && path === "/logout") {
      const raw = bearer(req);
      if (!raw) return json(401, { error: "unauthorized" });
      const info = await verifyToken(raw);
      if (!info) return json(401, { error: "unauthorized" });
      revokedTokens.add(raw);
      return new Response(null, { status: 204 });
    }

    // everything else
    return json(404, { error: "not_found" });
  };
}
