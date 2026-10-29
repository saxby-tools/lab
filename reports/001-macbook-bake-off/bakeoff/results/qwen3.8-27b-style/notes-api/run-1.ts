const JSON_CT = "application/json; charset=utf-8";
const MAX_TITLE = 100;
const MAX_BODY = 10_000;
const ALLOW_COLLECTION = "GET, POST";
const ALLOW_ITEM = "GET, DELETE";

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
  const notes = new Map<string, Note>();
  let nextId = 1;
  const now = options?.now ?? (() => new Date());

  function jsonBody(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": JSON_CT },
    });
  }

  function jsonBodyWithHeaders(
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    const all: Record<string, string> = {
      "Content-Type": JSON_CT,
      ...headers,
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: all,
    });
  }

  // One trailing slash is normalised away before matching.
  function parsePath(pathname: string):
    | { type: "collection" }
    | { type: "item"; id: string }
    | null
  {
    let path = pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    const segments = path.split("/");
    if (segments[0] !== "" || segments[1] !== "notes") {
      return null;
    }

    if (segments.length === 2) {
      return { type: "collection" };
    }

    if (segments.length === 3) {
      const id = segments[2];
      if (id.length === 0) {
        return null;
      }
      return { type: "item", id };
    }

    return null;
  }

  // Non-object JSON values (arrays, null, primitives)
  // are treated as an object with no keys.
  function isPlainObject(val: unknown): val is Record<string, unknown> {
    if (typeof val !== "object") {
      return false;
    }
    if (val === null) {
      return false;
    }
    if (Array.isArray(val)) {
      return false;
    }
    return true;
  }

  function validateTitle(raw: unknown): string | null {
    if (typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length < 1) {
      return null;
    }
    if (trimmed.length > MAX_TITLE) {
      return null;
    }
    return trimmed;
  }

  function validateBody(raw: unknown): string | null {
    // Absence is the default; only validate when present.
    if (raw === undefined) {
      return "";
    }
    if (typeof raw !== "string") {
      return null;
    }
    if (raw.length > MAX_BODY) {
      return null;
    }
    return raw;
  }

  async function handleCreate(req: Request): Promise<Response> {
    let text: string;
    try {
      text = await req.text();
    } catch {
      return jsonBody(400, { error: "invalid_json" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonBody(400, { error: "invalid_json" });
    }

    const obj = isPlainObject(parsed) ? parsed : {};

    const fields: string[] = [];

    const title = validateTitle(obj.title);
    if (title === null) {
      fields.push("title");
    }

    const body = validateBody(obj.body);
    if (body === null) {
      fields.push("body");
    }

    if (fields.length > 0) {
      return jsonBody(422, { error: "validation", fields });
    }

    const id = String(nextId++);
    const note: Note = {
      id,
      title: title as string,
      body: body as string,
      createdAt: now().toISOString(),
    };
    notes.set(id, note);

    return new Response(JSON.stringify(note), {
      status: 201,
      headers: {
        "Content-Type": JSON_CT,
        Location: `/notes/${id}`,
      },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const route = parsePath(url.pathname);
    const method = req.method;

    if (route === null) {
      return jsonBody(404, { error: "not_found" });
    }

    if (route.type === "collection") {
      if (method === "GET") {
        return jsonBody(200, Array.from(notes.values()));
      }

      if (method === "POST") {
        return handleCreate(req);
      }

      return jsonBodyWithHeaders(
        405,
        { error: "method_not_allowed" },
        { Allow: ALLOW_COLLECTION },
      );
    }

    // route.type is "item"
    const id = route.id;

    if (method === "GET") {
      const note = notes.get(id);
      if (note === undefined) {
        return jsonBody(404, { error: "not_found" });
      }
      return jsonBody(200, note);
    }

    if (method === "DELETE") {
      if (!notes.delete(id)) {
        return jsonBody(404, { error: "not_found" });
      }
      return new Response(null, { status: 204 });
    }

    return jsonBodyWithHeaders(
      405,
      { error: "method_not_allowed" },
      { Allow: ALLOW_ITEM },
    );
  };
}
