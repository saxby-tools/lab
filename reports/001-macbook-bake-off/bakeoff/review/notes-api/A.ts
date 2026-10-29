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
  // State maintained per handler instance
  const notes = new Map<string, Note>();
  let idCounter = 1;
  const now = options?.now ?? (() => new Date());

  /**
   * Helper to generate JSON responses with the required content type.
   */
  const jsonResponse = (data: any, status = 200, extraHeaders: HeadersInit = {}) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders,
      },
    });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, "http://localhost");
    let path = url.pathname;

    // Handle trailing slash: /notes/ becomes /notes, /notes/1/ becomes /notes/1
    // Root / remains /
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    const segments = path.split("/").filter(Boolean);

    // Route: /notes
    if (path === "/notes" || path === "") {
      if (req.method === "GET") {
        return jsonResponse(Array.from(notes.values()));
      }

      if (req.method === "POST") {
        let data;
        try {
          data = await req.json();
        } catch {
          return jsonResponse({ error: "invalid_json" }, 400);
        }

        // Valid JSON that is not an object counts as an object with no keys
        const payload = typeof data === "object" && data !== null ? data : {};
        const errors: string[] = [];

        const rawTitle = payload.title;
        const trimmedTitle = typeof rawTitle === "string" ? rawTitle.trim() : "";
        if (typeof rawTitle !== "string" || trimmedTitle.length < 1 || trimmedTitle.length > 100) {
          errors.push("title");
        }

        const rawBody = payload.body;
        if (rawBody !== undefined && (typeof rawBody !== "string" || rawBody.length > 10000)) {
          errors.push("body");
        }

        if (errors.length > 0) {
          return jsonResponse({ error: "validation", fields: errors }, 422);
        }

        const id = (idCounter++).toString();
        const note: Note = {
          id,
          title: trimmedTitle,
          body: typeof rawBody === "string" ? rawBody : "",
          createdAt: now().toISOString(),
        };

        notes.set(id, note);

        return jsonResponse(note, 201, {
          Location: `/notes/${id}`,
        });
      }

      return jsonResponse({ error: "method_not_allowed" }, 405, {
        Allow: "GET, POST",
      });
    }

    // Route: /notes/:id
    if (segments.length === 2 && segments[0] === "notes") {
      const id = segments[1];
      const note = notes.get(id);

      if (req.method === "GET") {
        if (!note) return jsonResponse({ error: "not_found" }, 404);
        return jsonResponse(note);
      }

      if (req.method === "DELETE") {
        if (!note) return jsonResponse({ error: "not_found" }, 404);
        notes.delete(id);
        return new Response(null, { status: 204 });
      }

      return jsonResponse({ error: "method_not_allowed" }, 405, {
        Allow: "GET, DELETE",
      });
    }

    // Unknown path
    return jsonResponse({ error: "not_found" }, 404);
  };
}
