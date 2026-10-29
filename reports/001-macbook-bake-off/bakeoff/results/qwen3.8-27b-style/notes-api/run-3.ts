const CONTENT_TYPE = "application/json; charset=utf-8";

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
  const now = options?.now ?? (() => new Date());
  const notes: Note[] = [];
  let nextId = 1;

  // -- helpers ----------------------------------------------------------

  function jsonBody(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": CONTENT_TYPE },
    });
  }

  function methodNotAllowed(allow: string): Response {
    return new Response(
      JSON.stringify({ error: "method_not_allowed" }),
      {
        status: 405,
        headers: {
          "Content-Type": CONTENT_TYPE,
          Allow: allow,
        },
      },
    );
  }

  // -- routing ----------------------------------------------------------

  // Strip at most one trailing slash so /notes/ matches /notes.
  function normalizePath(pathname: string): string {
    if (pathname.length > 1 && pathname.endsWith("/")) {
      return pathname.slice(0, -1);
    }
    return pathname;
  }

  type Route =
    | { type: "collection" }
    | { type: "item"; id: string }
    | null;

  function matchRoute(pathname: string): Route {
    const path = normalizePath(pathname);
    const parts = path.split("/");

    if (parts.length === 2 && parts[1] === "notes") {
      return { type: "collection" };
    }

    if (
      parts.length === 3
      && parts[1] === "notes"
      && parts[2] !== ""
    ) {
      return { type: "item", id: parts[2] };
    }

    return null;
  }

  // -- note creation ----------------------------------------------------

  type CreateResult =
    | { ok: true; note: Note }
    | { ok: false; fields: string[] };

  function createNoteFrom(raw: unknown): CreateResult {
    // Non-object JSON (array, null, primitive) has no own keys.
    const obj: Record<string, unknown> =
      raw !== null
      && typeof raw === "object"
      && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};

    const fields: string[] = [];

    // title is required; 1–100 chars after trimming.
    const titleRaw = obj.title;
    const title =
      typeof titleRaw === "string" ? titleRaw.trim() : "";
    if (title.length < 1 || title.length > 100) {
      fields.push("title");
    }

    // body is optional; when present it must be a string ≤ 10 000 chars.
    let body = "";
    if ("body" in obj) {
      const bodyRaw = obj.body;
      if (typeof bodyRaw !== "string" || bodyRaw.length > 10000) {
        fields.push("body");
      } else {
        body = bodyRaw;
      }
    }

    if (fields.length > 0) {
      return { ok: false, fields };
    }

    const note: Note = {
      id: String(nextId++),
      title,
      body,
      createdAt: now().toISOString(),
    };
    notes.push(note);
    return { ok: true, note };
  }

  // -- route handlers ---------------------------------------------------

  async function handleCollection(
    req: Request,
  ): Promise<Response> {
    if (req.method === "GET") {
      return jsonBody(notes);
    }

    if (req.method !== "POST") {
      return methodNotAllowed("GET, POST");
    }

    const text = await req.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonBody({ error: "invalid_json" }, 400);
    }

    const result = createNoteFrom(parsed);

    if (!result.ok) {
      return jsonBody(
        { error: "validation", fields: result.fields },
        422,
      );
    }

    return new Response(JSON.stringify(result.note), {
      status: 201,
      headers: {
        "Content-Type": CONTENT_TYPE,
        Location: `/notes/${result.note.id}`,
      },
    });
  }

  function handleItem(req: Request, id: string): Response {
    if (req.method === "GET") {
      const note = notes.find((n) => n.id === id);
      if (note === undefined) {
        return jsonBody({ error: "not_found" }, 404);
      }
      return jsonBody(note);
    }

    if (req.method === "DELETE") {
      const idx = notes.findIndex((n) => n.id === id);
      if (idx === -1) {
        return jsonBody({ error: "not_found" }, 404);
      }
      notes.splice(idx, 1);
      return new Response(null, { status: 204 });
    }

    return methodNotAllowed("GET, DELETE");
  }

  // -- entry point ------------------------------------------------------

  return async function handler(
    req: Request,
  ): Promise<Response> {
    const url = new URL(req.url);
    const route = matchRoute(url.pathname);

    if (route === null) {
      return jsonBody({ error: "not_found" }, 404);
    }

    if (route.type === "collection") {
      return handleCollection(req);
    }

    return handleItem(req, route.id);
  };
}
