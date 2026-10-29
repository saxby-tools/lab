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
  counter: number;
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function parseBody(req: Request): Promise<unknown> {
  return req.json().catch(() => {
    throw new Error("invalid_json");
  });
}

function validateNoteBody(data: unknown): { title: string; body: string } | null {
  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const errors: string[] = [];

  let title = "";
  if (typeof obj.title === "string") {
    const trimmed = obj.title.trim();
    if (trimmed.length >= 1 && trimmed.length <= 100) {
      title = trimmed;
    } else {
      errors.push("title");
    }
  } else {
    errors.push("title");
  }

  let body = "";
  if ("body" in obj) {
    if (typeof obj.body === "string" && obj.body.length <= 10000) {
      body = obj.body;
    } else {
      errors.push("body");
    }
  }

  if (errors.length > 0) {
    return { title: "", body: "", errors } as unknown as null;
  }

  return { title, body };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function errorResponse(error: string, fields?: string[], status?: number): Response {
  const body: { error: string; fields?: string[] } = { error };
  if (fields) {
    body.fields = fields;
  }

  const statusCode = status ?? (error === "not_found" || error === "invalid_json" ? 400 : 422);

  return jsonResponse(body, statusCode);
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const nowFn = options?.now ?? (() => new Date());
  const store: Store = { notes: [], counter: 0 };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = normalizePath(url.pathname);
    const parts = pathname === "/" ? [] : pathname.slice(1).split("/");

    try {
      if (parts.length === 0 || (parts.length === 1 && parts[0] === "notes")) {
        if (req.method === "GET") {
          return jsonResponse(store.notes);
        } else if (req.method === "POST") {
          let data: unknown;
          try {
            data = await parseBody(req);
          } catch {
            return errorResponse("invalid_json", undefined, 400);
          }

          const validated = validateNoteBody(data) as unknown as { title: string; body: string; errors?: string[] };
          if (validated.errors) {
            return errorResponse("validation", validated.errors, 422);
          }

          const note: Note = {
            id: String(store.counter + 1),
            title: validated.title,
            body: validated.body,
            createdAt: nowFn().toISOString(),
          };

          store.notes.push(note);
          store.counter += 1;

          return jsonResponse(note, 201, { Location: `/notes/${note.id}` });
        } else {
          return errorResponse("method_not_allowed", undefined, 405);
        }
      } else if (parts.length === 2 && parts[0] === "notes") {
        const id = parts[1];
        const noteIndex = store.notes.findIndex((n) => n.id === id);

        if (req.method === "GET") {
          if (noteIndex !== -1) {
            return jsonResponse(store.notes[noteIndex]);
          } else {
            return errorResponse("not_found", undefined, 404);
          }
        } else if (req.method === "DELETE") {
          if (noteIndex !== -1) {
            store.notes.splice(noteIndex, 1);
            return new Response(null, { status: 204 });
          } else {
            return errorResponse("not_found", undefined, 404);
          }
        } else {
          return errorResponse("method_not_allowed", undefined, 405);
        }
      } else {
        return errorResponse("not_found", undefined, 404);
      }
    } catch {
      return errorResponse("not_found", undefined, 404);
    }
  };
}
