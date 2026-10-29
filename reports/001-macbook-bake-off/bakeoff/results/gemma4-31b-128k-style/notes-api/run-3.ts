export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

const CONTENT_TYPE = "application/json; charset=utf-8";

function jsonResponse(
  status: number,
  body: any,
  headers: Record<string, string> = {},
): Response {
  const responseHeaders = new Headers({
    ...headers,
    "Content-Type": CONTENT_TYPE,
  });

  const content = body === null ? "" : JSON.stringify(body);

  return new Response(content, {
    status,
    headers: responseHeaders,
  });
}

function validateNoteBody(body: any): string[] {
  const errors: string[] = [];

  if (typeof body !== "object" || body === null) {
    errors.push("title");
    return errors;
  }

  const title = body.title;
  const trimmedTitle = typeof title === "string" ? title.trim() : "";

  if (trimmedTitle.length < 1 || trimmedTitle.length > 100) {
    errors.push("title");
  }

  const noteBody = body.body;
  if (
    noteBody !== undefined &&
    (typeof noteBody !== "string" || noteBody.length > 10000)
  ) {
    errors.push("body");
  }

  return errors;
}

function getNotes(store: Map<string, Note>): Note[] {
  return Array.from(store.values());
}

function createNote(
  store: Map<string, Note>,
  body: any,
  nowFn: () => Date,
  nextId: () => string,
): Note {
  const title = (body.title as string).trim();
  const noteBody = typeof body.body === "string" ? body.body : "";

  const note: Note = {
    id: nextId(),
    title,
    body: noteBody,
    createdAt: nowFn().toISOString(),
  };

  store.set(note.id, note);
  return note;
}

function getNoteById(store: Map<string, Note>, id: string): Note | undefined {
  return store.get(id);
}

function deleteNoteById(store: Map<string, Note>, id: string): boolean {
  return store.delete(id);
}

function handleNotesCollection(
  req: Request,
  store: Map<string, Note>,
  nowFn: () => Date,
  nextId: () => string,
): Response {
  if (req.method === "GET") {
    return jsonResponse(200, getNotes(store));
  }

  if (req.method === "POST") {
    let body: any;

    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }

    const errors = validateNoteBody(body);

    if (errors.length > 0) {
      return jsonResponse(422, { error: "validation", fields: errors });
    }

    const note = createNote(store, body, nowFn, nextId);

    return jsonResponse(
      201,
      note,
      { Location: `/notes/${note.id}` },
    );
  }

  return jsonResponse(405, { error: "method_not_allowed" }, {
    Allow: "GET, POST",
  });
}

function handleNotesResource(
  req: Request,
  id: string,
  store: Map<string, Note>,
): Response {
  if (req.method === "GET") {
    const note = getNoteById(store, id);

    if (!note) {
      return jsonResponse(404, { error: "not_found" });
    }

    return jsonResponse(200, note);
  }

  if (req.method === "DELETE") {
    const deleted = deleteNoteById(store, id);

    if (!deleted) {
      return jsonResponse(404, { error: "not_found" });
    }

    return jsonResponse(204, null);
  }

  return jsonResponse(405, { error: "method_not_allowed" }, {
    Allow: "GET, DELETE",
  });
}

function routeRequest(
  req: Request,
  store: Map<string, Note>,
  nowFn: () => Date,
  nextId: () => string,
): Response {
  const url = new URL(req.url, "http://localhost");
  let path = url.pathname;

  if (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }

  if (path === "/notes" || path === "") {
    // The prompt suggests /notes is the base path.
    // If root / is accessed, we treat as 404 unless explicitly /notes.
    if (path === "/notes") {
      return handleNotesCollection(req, store, nowFn, nextId);
    }
  }

  if (path.startsWith("/notes/")) {
    const segments = path.split("/").filter(Boolean);

    if (segments.length === 2) {
      return handleNotesResource(req, segments[1], store);
    }
  }

  return jsonResponse(404, { error: "not_found" });
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const store = new Map<string, Note>();
  let counter = 0;
  const nowFn = options?.now ?? (() => new Date());

  const nextId = (): string => {
    counter++;
    return counter.toString();
  };

  return async (req: Request) => {
    return routeRequest(req, store, nowFn, nextId);
  };
}
