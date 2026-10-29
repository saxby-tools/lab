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
  const nowFn: () => Date = options.now ?? (() => new Date());
  const revoked = new Set<string>();

  // ── helpers ──────────────────────────────────────────────────────────

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function extractBearer(header: string | null): string | null {
    if (header === null) return null;
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return null;
    const token = header.slice(prefix.length);
    return token.length === 0 ? null : token;
  }

  function toB64Url(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64Url(s: string): Uint8Array {
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  // ── token issue / verify ─────────────────────────────────────────────

  async function makeToken(username: string): Promise<{ token: string; expiresAt: string }> {
    const t = nowFn();
    const exp = t.getTime() + 3_600_000;
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const nonceHex = Array.from(nonce)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const payloadJson = JSON.stringify({ u: username, e: exp, n: nonceHex });
    const payloadBytes = new TextEncoder().encode(payloadJson);
    const payloadB64 = toB64Url(payloadBytes);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
    const sigB64 = toB64Url(new Uint8Array(sig));

    return {
      token: `${payloadB64}.${sigB64}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  async function checkToken(raw: string): Promise<{ username: string; role: Role } | null> {
    // revoked?
    if (revoked.has(raw)) return null;

    // must be exactly two dot-separated segments, both non-empty
    const parts = raw.split(".");
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;

    // decode payload
    let payloadStr: string;
    try {
      payloadStr = new TextDecoder().decode(fromB64Url(parts[0]));
    } catch {
      return null;
    }

    // parse and validate payload fields
    let u: string, e: number;
    try {
      const obj: unknown = JSON.parse(payloadStr);
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
      const rec = obj as Record<string, unknown>;
      if (typeof rec.u !== "string" || typeof rec.e !== "number") return null;
      u = rec.u;
      e = rec.e;
    } catch {
      return null;
    }

    // verify HMAC signature (constant-time internally)
    let sigBytes: Uint8Array;
    try {
      sigBytes = fromB64Url(parts[1]);
    } catch {
      return null;
    }
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "HMAC",
        key,
        sigBytes,
        new TextEncoder().encode(payloadStr),
      );
      if (!ok) return null;
    } catch {
      return null;
    }

    // expiry: valid until exactly one hour; at that instant it is expired
    if (nowFn().getTime() >= e) return null;

    // look up user (case-sensitive, exact match)
    const user = users.find((usr) => usr.username === u);
    if (user === undefined) return null;

    return { username: user.username, role: user.role };
  }

  // ── request handler ──────────────────────────────────────────────────

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // POST /login ──────────────────────────────────────────────────────
    if (path === "/login" && method === "POST") {
      let body: string;
      try {
        body = await req.text();
      } catch {
        return json(400, { error: "invalid_request" });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: "invalid_request" });
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return json(400, { error: "invalid_request" });
      }

      const obj = parsed as Record<string, unknown>;
      if (typeof obj.username !== "string" || typeof obj.password !== "string") {
        return json(400, { error: "invalid_request" });
      }

      // uniform 401 whether the username is unknown or the password is wrong
      const user = users.find(
        (usr) => usr.username === obj.username && usr.password === obj.password,
      );
      if (user === undefined) {
        return json(401, { error: "invalid_credentials" });
      }

      const { token, expiresAt } = await makeToken(user.username);
      return json(200, { token, expiresAt });
    }

    // Authenticated routes ─────────────────────────────────────────────
    if (
      (path === "/me" && method === "GET") ||
      (path === "/admin/stats" && method === "GET") ||
      (path === "/logout" && method === "POST")
    ) {
      const raw = extractBearer(req.headers.get("Authorization"));
      if (raw === null) return json(401, { error: "unauthorized" });

      const auth = await checkToken(raw);
      if (auth === null) return json(401, { error: "unauthorized" });

      if (path === "/me") {
        return json(200, { username: auth.username, role: auth.role });
      }

      if (path === "/admin/stats") {
        if (auth.role !== "admin") return json(403, { error: "forbidden" });
        const admins = users.filter((usr) => usr.role === "admin").length;
        return json(200, { users: users.length, admins });
      }

      // POST /logout — revoke this specific token, return 204 null body
      revoked.add(raw);
      return new Response(null, { status: 204 });
    }

    // Everything else ──────────────────────────────────────────────────
    return json(404, { error: "not_found" });
  };
}
