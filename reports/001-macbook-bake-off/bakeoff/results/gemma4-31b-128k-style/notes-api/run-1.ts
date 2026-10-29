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

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const state = {
    notes: new Map<string, Note>(),
    nextId: 1,
  };

  const now = options?.now ?? (() => new Date());

  return (req: Request) => handleRequest(req, state, now);
}

async function handleRequest(
  req: Request,
  state: { notes: Map<string, Note>; nextId: number },
  now: () => Date,
): Promise<Response> {
  const url = new URL(req.url, "http://n");
  let path = url.pathname;

  // Normalize trailing slash for consistent matching
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  if (path === "/notes") {
    return handleCollection(req, state, now);
  }

  if (path.startsWith("/notes/")) {
    const segments = path.split("/");
    if (segments.length === 3) {
      return handleResource(req, state, segments[2]);
    }
  }

  return errorResponse(404, "not_found");
}

async function handleCollection(
  req: Request,
  state: { notes: Map<string, Note>; nextId: number },
  now: () => Date,
): Promise<Response> {
  if (req.method === "GET") {
    const notes = Array.from(state.notes.values());
    return jsonResponse(200, notes);
  }

  if (req.method === "POST") {
    return handlePostNotes(req, state, now);
  }

  return errorResponse(405, "method_not_allowed", "GET, POST");
}

async function handlePostNotes(
  req: Request,
  state: { notes: Map<string, Note>; nextId: number },
  now: () => Date,
): Promise<Response> {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, "invalid_json");
  }

  const { isValid, fields, trimmedTitle, body } = validatePayload(payload);
  if (!isValid) {
    return errorResponse(422, "validation", undefined, fields);
  }

  const id = (state.nextId++).toString();
  const note: Note = {
    id,
    title: trimmedTitle,
    body,
    createdAt: now().toISOString(),
  };

  state.notes.set(id, note);

  return jsonResponse(201, note, { Location: `/notes/${id}` });
}

function validatePayload(payload: any) {
  const fields: string[] = [];
  const data = typeof payload === "object" && payload !== null 
    ? payload 
    : {};

  const trimmedTitle = typeof data.title === "string" 
    ? data.title.trim() 
    : "";

  if (trimmedTitle.length < 1 || trimmedTitle.length > 100) {
    fields.push("title");
  }

  const body = data.body ?? "";
  if (typeof body !== "string" || body.length > 10000) {
    fields.push("body");
  }

  return {
    isValid: fields.length === 0,
    fields,
    trimmedTitle,
    body,
  };
}

async function handleResource(
  req: Request,
  state: { notes: Map<string, Note>; nextId: number },
  id: string,
): Promise<Response> {
  const note = state.notes.get(id);
  if (!note) {
    return errorResponse(404, "not_found");
  }

  if (req.method === "GET") {
    return jsonResponse(200, note);
  }

  if (req.method === "DELETE") {
    state.notes.delete(id);
    return jsonResponse(204, null);
  }

  return errorResponse(405, "method_not_allowed", "GET, DELETE");
}

function jsonResponse(
  status: number,
  body: any,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({ [CONTENT_TYPE]: "application/json; charset=utf-8" });
  
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  const responseBody = body === null ? null : JSON.stringify(body);

  return new Response(responseBody, {
    status,
    headers,
  });
}

function errorResponse(
  status: number,
  error: string,
  allow?: string,
  fields?: string[],
): Response {
  const headers = new Headers({ [CONTENT_TYPE]: "application/json; charset=utf-8" });
  if (allow) {
    headers.set("Allow", allow);
  }

  const body = fields 
    ? { error, fields } 
    : { error };

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}
