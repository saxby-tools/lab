export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const now = options?.now ?? (() => new Date());
  const notes: Note[] = [];
  let nextId = 1;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Strip exactly one trailing slash (but not root "/")
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    const segments = pathname.split("/").slice(1);
    const method = req.method;

    // Determine route
    let isCollection = false;
    let isIndividual = false;
    let id = "";

    if (segments.length === 1 && segments[0] === "notes") {
      isCollection = true;
    } else if (
      segments.length === 2 && segments[0] === "notes" && segments[1] !== ""
    ) {
      isIndividual = true;
      id = segments[1];
    }

    // Unknown path
    if (!isCollection && !isIndividual) {
      return jsonResponse(404, { error: "not_found" });
    }

    // Collection routes: GET /notes, POST /notes
    if (isCollection) {
      if (method === "GET") {
        return jsonResponse(200, notes);
      }

      if (method === "POST") {
        let parsed: unknown;
        try {
          const raw = await req.text();
          parsed = JSON.parse(raw);
        } catch {
          return jsonResponse(400, { error: "invalid_json" });
        }

        // Non-object values (array, null, string, number, boolean)
        // are treated as an object with no keys
        const obj =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};

        const fields: string[] = [];
        let title = "";
        let body = "";

        // Validate title
        let titleValid = false;
        if ("title" in obj && typeof obj.title === "string") {
          const trimmed = (obj.title as string).trim();
          if (trimmed.length >= 1 && trimmed.length <= 100) {
            title = trimmed;
            titleValid = true;
          }
        }
        if (!titleValid) {
          fields.push("title");
        }

        // Validate body
        let bodyValid = true;
        if ("body" in obj) {
          if (typeof obj.body !== "string" || (obj.body as string).length > 10_000) {
            bodyValid = false;
          } else {
            body = obj.body as string;
          }
        }
        if (!bodyValid) {
          fields.push("body");
        }

        if (fields.length > 0) {
          return jsonResponse(422, { error: "validation", fields });
        }

        const note: Note = {
          id: String(nextId),
          title,
          body,
          createdAt: now().toISOString(),
        };
        nextId++;
        notes.push(note);

        return new Response(JSON.stringify(note), {
          status: 201,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Location: `/notes/${note.id}`,
          },
        });
      }

      // Unsupported method on collection
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Allow: "GET, POST",
        },
      });
    }

    // Individual routes: GET /notes/:id, DELETE /notes/:id
    if (method === "GET" || method === "DELETE") {
      const index = notes.findIndex((n) => n.id === id);
      if (index === -1) {
        return jsonResponse(404, { error: "not_found" });
      }

      if (method === "GET") {
        return jsonResponse(200, notes[index]);
      }

      // DELETE
      notes.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    // Unsupported method on individual
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Allow: "GET, DELETE",
      },
    });
  };
}
