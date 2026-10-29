// solution.ts

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
  const notes = new Map<string, Note>();
  let nextId = 1;

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

  const notFound = () => json(404, { error: "not_found" });
  const methodNotAllowed = (allow: string) =>
    new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Allow: allow,
      },
    });

  const trimOneSlash = (path: string): string =>
    path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const segments = trimOneSlash(url.pathname)
      .split("/")
      .filter((s) => s.length > 0);

    // /notes route
    if (segments.length === 1 && segments[0] === "notes") {
      if (req.method === "GET") {
        const arr = Array.from(notes.values());
        return json(200, arr);
      }
      if (req.method === "POST") {
        let data: unknown;
        try {
          data = await req.json();
        } catch {
          return json(400, { error: "invalid_json" });
        }

        const obj = typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};

        const fields: string[] = [];

        const titleRaw = obj["title"];
        const title =
          typeof titleRaw === "string" ? titleRaw.trim() : null;
        if (title === null || title.length === 0 || title.length > 100) {
          fields.push("title");
        }

        const bodyRaw = obj["body"];
        const body =
          typeof bodyRaw === "string" ? bodyRaw : undefined;
        if (bodyRaw !== undefined && (typeof bodyRaw !== "string" || bodyRaw.length > 10000)) {
          fields.push("body");
        }

        if (fields.length > 0) {
          return json(422, { error: "validation", fields });
        }

        const id = String(nextId++);
        const createdAt = now().toISOString();
        const note: Note = {
          id,
          title: title!,
          body: body ?? "",
          createdAt,
        };
        notes.set(id, note);
        return new Response(JSON.stringify(note), {
          status: 201,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Location: `/notes/${id}`,
          },
        });
      }
      return methodNotAllowed("GET, POST");
    }

    // /notes/:id route
    if (segments.length === 2 && segments[0] === "notes" && segments[1].length > 0) {
      const id = segments[1];
      if (req.method === "GET") {
        const note = notes.get(id);
        if (!note) {
          return notFound();
        }
        return json(200, note);
      }
      if (req.method === "DELETE") {
        if (!notes.delete(id)) {
          return notFound();
        }
        return new Response(null, { status: 204 });
      }
      return methodNotAllowed("GET, DELETE");
    }

    return notFound();
  };
}
