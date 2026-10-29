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
  // Store state in the closure of createHandler
  const store = new Map<string, Note>();
  let nextId = 1;
  const nowFn = options?.now ?? (() => new Date());

  /**
   * Helper to create a JSON response.
   */
  const jsonResponse = (
    status: number,
    data: any,
    allow?: string,
  ): Response => {
    const headers = new Headers();
    if (status !== 204) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    if (allow) {
      headers.set("Allow", allow);
    }

    return new Response(data !== null ? JSON.stringify(data) : null, {
      status,
      headers,
    });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Split pathname and filter out empty strings to handle trailing slashes
    const segments = url.pathname.split("/").filter(Boolean);

    // Route: /notes
    if (segments.length === 1 && segments[0] === "notes") {
      if (req.method === "GET") {
        // Map maintains insertion order, so Array.from is oldest first
        return jsonResponse(200, Array.from(store.values()));
      }

      if (req.method === "POST") {
        let jsonBody: any;
        try {
          jsonBody = await req.json();
        } catch {
          return jsonResponse(400, { error: "invalid_json" });
        }

        // "Valid JSON that is not an object counts as an object with no keys"
        const body = typeof jsonBody === "object" && jsonBody !== null ? jsonBody : {};

        const fields: string[] = [];
        const titleVal = body.title;
        const trimmedTitle = typeof titleVal === "string" ? titleVal.trim() : null;

        if (trimmedTitle === null || trimmedTitle.length < 1 || trimmedTitle.length > 100) {
          fields.push("title");
        }

        const bodyVal = body.body;
        if (bodyVal !== undefined && (typeof bodyVal !== "string" || bodyVal.length > 10000)) {
          fields.push("body");
        }

        if (fields.length > 0) {
          return jsonResponse(422, { error: "validation", fields });
        }

        const id = (nextId++).toString();
        const note: Note = {
          id,
          title: trimmedTitle!,
          body: typeof bodyVal === "string" ? bodyVal : "",
          createdAt: nowFn().toISOString(),
        };

        store.set(id, note);

        const res = jsonResponse(201, note);
        res.headers.set("Location", `/notes/${id}`);
        return res;
      }

      return jsonResponse(405, { error: "method_not_allowed" }, "GET, POST");
    }

    // Route: /notes/:id
    if (segments.length === 2 && segments[0] === "notes") {
      const id = segments[1];

      if (req.method === "GET") {
        const note = store.get(id);
        if (!note) {
          return jsonResponse(404, { error: "not_found" });
        }
        return jsonResponse(200, note);
      }

      if (req.method === "DELETE") {
        const note = store.get(id);
        if (!note) {
          return jsonResponse(404, { error: "not_found" });
        }
        store.delete(id);
        return jsonResponse(204, null);
      }

      return jsonResponse(405, { error: "method_not_allowed" }, "GET, DELETE");
    }

    // Unknown path
    return jsonResponse(404, { error: "not_found" });
  };
}
