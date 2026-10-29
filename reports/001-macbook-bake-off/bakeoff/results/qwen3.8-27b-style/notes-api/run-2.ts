// application/json with explicit charset, required by the spec.
const JSON_CT = "application/json; charset=utf-8";
const MAX_TITLE = 100;
const MAX_BODY = 10_000;

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  // Each call to createHandler gets its own isolated store.
  const notes: Note[] = [];
  let nextId = 1;

  // Tests can inject a clock; production uses the system clock.
  const nowFn = options?.now ?? (() => new Date());

  // ── helpers ──────────────────────────────────────────────────────

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": JSON_CT },
    });
  }

  type ValidationOk = {
    ok: true;
    title: string;
    body: string;
  };

  type ValidationFail = {
    ok: false;
    fields: string[];
  };

  // Non-object JSON (arrays, null, primitives) is treated as {}.
  function validate(
    payload: unknown,
  ): ValidationOk | ValidationFail {
    const obj: Record<string, unknown> =
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};

    const fields: string[] = [];

    // title is required; must be a string, 1–100 chars after trim.
    const rawTitle = obj.title;
    let title = "";
    if (typeof rawTitle !== "string") {
      fields.push("title");
    } else {
      title = rawTitle.trim();
      if (title.length === 0 || title.length > MAX_TITLE) {
        fields.push("title");
      }
    }

    // body is optional; if the key is present it must be a string ≤ 10 000.
    let body = "";
    if ("body" in obj) {
      const rawBody = obj.body;
      if (typeof rawBody !== "string" || rawBody.length > MAX_BODY) {
        fields.push("body");
      } else {
        body = rawBody;
      }
    }

    if (fields.length > 0) {
      return { ok: false, fields };
    }

    return { ok: true, title, body };
  }

  // ── handler ──────────────────────────────────────────────────────

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Normalise one optional trailing slash.
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    const segments = path
      .split("/")
      .filter((s) => s.length > 0);

    // Every route lives under /notes.
    if (segments[0] !== "notes") {
      return json({ error: "not_found" }, 404);
    }

    const method = req.method;

    // /notes  –  collection
    if (segments.length === 1) {
      if (method === "GET") {
        return json(notes);
      }

      if (method === "POST") {
        const text = await req.text();

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return json({ error: "invalid_json" }, 400);
        }

        const result = validate(parsed);
        if (!result.ok) {
          return json(
            { error: "validation", fields: result.fields },
            422,
          );
        }

        // ID is monotonically increasing; a deleted id is never reused.
        const id = String(nextId++);
        const note: Note = {
          id,
          title: result.title,
          body: result.body,
          createdAt: nowFn().toISOString(),
        };
        notes.push(note);

        const resp = json(note, 201);
        resp.headers.set("Location", `/notes/${id}`);
        return resp;
      }

      const notAllowed = json({ error: "method_not_allowed" }, 405);
      notAllowed.headers.set("Allow", "GET, POST");
      return notAllowed;
    }

    // /notes/:id  –  item
    if (segments.length === 2) {
      const id = segments[1];
      const idx = notes.findIndex((n) => n.id === id);

      if (method === "GET") {
        if (idx === -1) {
          return json({ error: "not_found" }, 404);
        }
        return json(notes[idx]);
      }

      if (method === "DELETE") {
        if (idx === -1) {
          return json({ error: "not_found" }, 404);
        }
        notes.splice(idx, 1);
        return new Response(null, { status: 204 });
      }

      const notAllowed = json({ error: "method_not_allowed" }, 405);
      notAllowed.headers.set("Allow", "GET, DELETE");
      return notAllowed;
    }

    // Any deeper path (e.g. /notes/1/extra) is unknown.
    return json({ error: "not_found" }, 404);
  };
}
