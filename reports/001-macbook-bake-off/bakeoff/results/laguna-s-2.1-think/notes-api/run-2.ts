export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

interface Store {
  notes: Note[];
  nextId: number;
}

function normalizePath(pathname: string): string {
  // Remove one trailing slash if present (but not for root "/")
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function jsonResponse(status: number, data: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function errorResponse(status: number, error: string): Response {
  return jsonResponse(status, { error });
}

function methodNotAllowedResponse(allowedMethods: string[]): Response {
  return errorResponse(405, "method_not_allowed", {
    Allow: allowedMethods.join(", "),
  });
}

function validateNoteBody(body: unknown): { valid: true; title: string; noteBody: string } | { valid: false; fields: string[] } {
  const fields: string[] = [];

  // Treat non-objects as empty objects
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { valid: false, fields: ["title"] };
  }

  const obj = body as Record<string, unknown>;

  // Title validation
  let title: string;
  if (typeof obj.title !== "string") {
    fields.push("title");
  } else {
    const trimmedTitle = obj.title.trim();
    if (trimmedTitle.length < 1 || trimmedTitle.length > 100) {
      fields.push("title");
    } else {
      title = trimmedTitle;
    }
  }

  // Body validation
  let noteBody: string;
  if (obj.body === undefined) {
    noteBody = "";
  } else if (typeof obj.body !== "string") {
    fields.push("body");
  } else if (obj.body.length > 10000) {
    fields.push("body");
  } else {
    noteBody = obj.body;
  }

  if (fields.length > 0) {
    return { valid: false, fields };
  }

  // We've validated, so title and noteBody are set
  return { valid: true, title: title!, noteBody: noteBody! };
}

export function createHandler(options?: HandlerOptions): (req: Request) => Promise<Response> {
  const store: Store = {
    notes: [],
    nextId: 1,
  };

  const nowFn = options?.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = normalizePath(url.pathname);
    const method = req.method;

    // Route: /notes
    if (pathname === "/notes") {
      if (method === "GET") {
        return jsonResponse(200, store.notes);
      }
      if (method === "POST") {
        let body: unknown;
        try {
          const text = await req.text();
          if (text.trim() === "") {
            throw new Error("empty");
          }
          body = JSON.parse(text);
        } catch {
          return errorResponse(400, "invalid_json");
        }

        const result = validateNoteBody(body);
        if (!result.valid) {
          return jsonResponse(422, { error: "validation", fields: result.fields });
        }

        const note: Note = {
          id: String(store.nextId++),
          title: result.title,
          body: result.noteBody,
          createdAt: nowFn().toISOString(),
        };
        store.notes.push(note);

        return jsonResponse(201, note, { Location: `/notes/${note.id}` });
      }
      return methodNotAllowedResponse(["GET", "POST"]);
    }

    // Route: /notes/:id (single segment)
    const match = pathname.match(/^\/notes\/([^/]+)$/);
    if (match) {
      const id = match[1];
      // Check if id is a positive integer that exists in our store
      const noteIndex = store.notes.findIndex((n) => n.id === id);

      if (method === "GET") {
        if (noteIndex === -1) {
          return errorResponse(404, "not_found");
        }
        return jsonResponse(200, store.notes[noteIndex]);
      }
      if (method === "DELETE") {
        if (noteIndex === -1) {
          return errorResponse(404, "not_found");
        }
        store.notes.splice(noteIndex, 1);
        return new Response(null, { status: 204 });
      }
      return methodNotAllowedResponse(["GET", "DELETE"]);
    }

    // Unknown path
    return errorResponse(404, "not_found");
  };
}
