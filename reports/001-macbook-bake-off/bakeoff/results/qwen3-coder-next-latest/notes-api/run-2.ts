export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

export function createHandler(options?: HandlerOptions): (req: Request) => Promise<Response> {
  const now = options?.now ?? (() => new Date());
  let notes: Note[] = [];
  let nextId = 1;

  const respond = (status: number, body?: any, headers?: Record<string, string>): Response => {
    const responseHeaders: HeadersInit = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        responseHeaders[key] = value;
      }
    }
    return new Response(body !== undefined ? JSON.stringify(body) : null, {
      status,
      headers: responseHeaders,
    });
  };

  const handleNotes = async (req: Request): Promise<Response> => {
    switch (req.method) {
      case "GET":
        return respond(200, notes);

      case "POST":
        let body: any;
        try {
          const text = await req.text();
          if (text.trim() === "") {
            return respond(400, { error: "invalid_json" });
          }
          body = JSON.parse(text);
        } catch {
          return respond(400, { error: "invalid_json" });
        }

        const errors: string[] = [];
        let title: string;
        let noteBody = "";

        if (body == null || typeof body !== "object" || Array.isArray(body)) {
          errors.push("title");
          if ("body" in body) {
            if (typeof body.body !== "string") {
              errors.push("body");
            } else if (body.body.length > 10000) {
              errors.push("body");
            }
          } else {
            // body is not provided, use default ""
          }
          return respond(422, { error: "validation", fields: errors });
        }

        // Validate title
        if (!("title" in body) || typeof body.title !== "string") {
          errors.push("title");
        } else {
          title = body.title.trim();
          if (title.length < 1 || title.length > 100) {
            errors.push("title");
          }
        }

        // Validate body if provided
        if ("body" in body) {
          if (typeof body.body !== "string") {
            errors.push("body");
          } else if (body.body.length > 10000) {
            errors.push("body");
          } else {
            noteBody = body.body;
          }
        }

        if (errors.length > 0) {
          return respond(422, { error: "validation", fields: errors });
        }

        const id = String(nextId++);
        const note: Note = {
          id,
          title,
          body: noteBody,
          createdAt: now().toISOString(),
        };
        notes.push(note);
        return respond(201, note, { "Location": `/notes/${id}` });

      default:
        return respond(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
    }
  };

  const handleNote = async (id: string, req: Request): Promise<Response> => {
    // Validate id is a valid positive integer string that fits in the sequence
    // We don't check if it's in use yet, just that it matches the format
    if (!/^\d+$/.test(id)) {
      return respond(404, { error: "not_found" });
    }

    const noteIndex = notes.findIndex((n) => n.id === id);
    if (req.method === "GET") {
      if (noteIndex === -1) {
        return respond(404, { error: "not_found" });
      }
      return respond(200, notes[noteIndex]);
    } else if (req.method === "DELETE") {
      if (noteIndex === -1) {
        return respond(404, { error: "not_found" });
      }
      notes.splice(noteIndex, 1);
      return new Response(null, { status: 204 });
    } else {
      return respond(405, { error: "method_not_allowed" }, { Allow: "GET, DELETE" });
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let path = url.pathname;

    // Remove trailing slash unless it's the root
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    if (path === "/notes") {
      return await handleNotes(req);
    }

    // Match /notes/:id
    const match = path.match(/^\/notes\/([^/]+)$/);
    if (match) {
      const id = match[1];
      return await handleNote(id, req);
    }

    return respond(404, { error: "not_found" });
  };
}
