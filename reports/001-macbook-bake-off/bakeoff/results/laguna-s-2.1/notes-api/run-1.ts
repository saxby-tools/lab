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
  const notes: Note[] = [];
  const now = options?.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    const method = req.method;

    if (pathname === "/notes") {
      if (method === "GET") {
        return json(200, notes);
      }
      if (method === "POST") {
        try {
          const bodyText = await req.text();
          const parsed = bodyText.trim() === "" ? undefined : JSON.parse(bodyText);
          const obj = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          const fields: string[] = [];

          const title = obj.title;
          if (typeof title !== "string") {
            fields.push("title");
          } else {
            const trimmed = title.trim();
            if (trimmed.length < 1 || trimmed.length > 100) {
              fields.push("title");
            }
          }

          const body = obj.body;
          if (body !== undefined && (typeof body !== "string" || body.length > 10000)) {
            fields.push("body");
          }

          if (fields.length > 0) {
            return json(422, { error: "validation", fields });
          }

          const id = String(notes.length + 1);
          const note: Note = {
            id,
            title: title!.trim(),
            body: body ?? "",
            createdAt: now().toISOString(),
          };
          notes.push(note);
          return json(201, note, { Location: `/notes/${id}` });
        } catch {
          return json(400, { error: "invalid_json" });
        }
      }
      return methodNotAllowed("GET, POST");
    }

    const match = pathname.match(/^\/notes\/(.*)$/);
    if (match) {
      const id = match[1];
      const index = notes.findIndex((n) => n.id === id);

      if (method === "GET") {
        if (index === -1) return json(404, { error: "not_found" });
        return json(200, notes[index]);
      }
      if (method === "DELETE") {
        if (index === -1) return json(404, { error: "not_found" });
        notes.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      return methodNotAllowed("GET, DELETE");
    }

    return json(404, { error: "not_found" });
  };

  function json(status: number, data: unknown, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    });
  }

  function methodNotAllowed(allow: string): Response {
    return json(405, { error: "method_not_allowed" }, { Allow: allow });
  }
}
