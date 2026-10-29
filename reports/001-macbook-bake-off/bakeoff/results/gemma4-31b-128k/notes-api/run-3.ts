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
  // State kept in closure
  const notes = new Map<string, Note>();
  let nextId = 1;

  const jsonResponse = (status: number, body: any, headers: Record<string, string> = {}) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
      },
    });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let path = url.pathname;

    // Handle trailing slash: allow one trailing slash by removing it if it's not the root
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    const segments = path.split("/"); // e.g., "/notes/1" -> ["", "notes", "1"]

    // Route: /notes
    if (segments.length === 2 && segments[1] === "notes") {
      if (req.method === "GET") {
        return jsonResponse(200, Array.from(notes.values()));
      }

      if (req.method === "POST") {
        let payload: any;
        try {
          const text = await req.text();
          if (!text) throw new Error("Empty body");
          payload = JSON.parse(text);
        } catch {
          return jsonResponse(400, { error: "invalid_json" });
        }

        // Treat non-object JSON (arrays, null, etc) as empty objects
        if (typeof payload !== "object" || payload === null) {
          payload = {};
        }

        const fields: string[] = [];
        
        // Title validation
        let trimmedTitle = "";
        if (typeof payload.title !== "string") {
          fields.push("title");
        } else {
          trimmedTitle = payload.title.trim();
          if (trimmedTitle.length < 1 || trimmedTitle.length > 100) {
            fields.push("title");
          }
        }

        // Body validation
        let finalBody = "";
        if (payload.body !== undefined) {
          if (typeof payload.body !== "string" || payload.body.length > 10000) {
            fields.push("body");
          } else {
            finalBody = payload.body;
          }
        }

        if (fields.length > 0) {
          return jsonResponse(422, { error: "validation", fields });
        }

        const id = (nextId++).toString();
        const note: Note = {
          id,
          title: trimmedTitle,
          body: finalBody,
          createdAt: (options?.now?.() || new Date()).toISOString(),
        };

        notes.set(id, note);
        return jsonResponse(201, note, { Location: `/notes/${id}` });
      }

      return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
    }

    // Route: /notes/:id
    if (segments.length === 3 && segments[1] === "notes") {
      const id = segments[2];
      const note = notes.get(id);

      if (req.method === "GET") {
        if (!note) return jsonResponse(404, { error: "not_found" });
        return jsonResponse(200, note);
      }

      if (req.method === "DELETE") {
        if (!note) return jsonResponse(404, { error: "not_found" });
        notes.delete(id);
        return new Response(null, { status: 204 });
      }

      return jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET, DELETE" });
    }

    // Unknown Path
    return jsonResponse(404, { error: "not_found" });
  };
}
