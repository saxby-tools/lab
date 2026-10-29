export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

const CHARSET = "application/json; charset=utf-8";
const MAX_TITLE = 100;
const MAX_BODY = 10000;

function jsonResponse(
  status: number,
  body: any,
  allow?: string,
): Response {
  if (status === 204) {
    return new Response(null, { status });
  }

  const headers = new Headers();
  headers.set("Content-Type", CHARSET);

  if (allow) {
    headers.set("Allow", allow);
  }

  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function isTitleInvalid(title: unknown): boolean {
  if (typeof title !== "string") {
    return true;
  }

  const trimmed = title.trim();

  if (trimmed.length === 0) {
    return true;
  }

  if (trimmed.length > MAX_TITLE) {
    return true;
  }

  return false;
}

function isBodyInvalid(body: unknown): boolean {
  if (body === undefined) {
    return false;
  }

  if (typeof body !== "string") {
    return true;
  }

  if (body.length > MAX_BODY) {
    return true;
  }

  return false;
}

function validateNote(data: any): string[] {
  const fields = [];

  if (isTitleInvalid(data.title)) {
    fields.push("title");
  }

  if (isBodyInvalid(data.body)) {
    fields.push("body");
  }

  return fields;
}

async function parseRequestBody(req: Request): Promise<any> {
  const text = await req.text();

  if (!text) {
    throw new Error("invalid_json");
  }

  try {
    const parsed = JSON.parse(text);

    if (parsed === null || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch {
    throw new Error("invalid_json");
  }
}

async function handleNotes(
  req: Request,
  state: {
    notes: Map<string, Note>;
    nextId: number;
    now: () => Date;
  },
): Promise<Response> {
  if (req.method === "GET") {
    const list = Array.from(state.notes.values());
    return jsonResponse(200, list);
  }

  if (req.method === "POST") {
    let data;

    try {
      data = await parseRequestBody(req);
    } catch (e: any) {
      return jsonResponse(400, { error: "invalid_json" });
    }

    const fields = validateNote(data);

    if (fields.length > 0) {
      return jsonResponse(422, { error: "validation", fields });
    }

    const id = (state.nextId++).toString();
    const note: Note = {
      id,
      title: data.title.trim(),
      body: data.body ?? "",
      createdAt: state.now().toISOString(),
    };

    state.notes.set(id, note);

    const headers = new Headers();
    headers.set("Content-Type", CHARSET);
    headers.set("Location", `/notes/${id}`);

    return new Response(JSON.stringify(note), {
      status: 201,
      headers,
    });
  }

  return jsonResponse(405, { error: "method_not_allowed" }, "GET, POST");
}

async function handleNoteId(
  req: Request,
  state: { notes: Map<string, Note> },
  id: string,
): Promise<Response> {
  const note = state.notes.get(id);

  if (!note) {
    return jsonResponse(404, { error: "not_found" });
  }

  if (req.method === "GET") {
    return jsonResponse(200, note);
  }

  if (req.method === "DELETE") {
    state.notes.delete(id);
    return jsonResponse(204, null);
  }

  return jsonResponse(405, { error: "method_not_allowed" }, "GET, DELETE");
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const notes = new Map<string, Note>();
  let nextId = 1;
  const now = options?.now || (() => new Date());

  return async (req: Request): Promise<Response> {
    const url = new URL(req.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length === 1 && segments[0] === "notes") {
      return handleNotes(
        req,
        { notes, nextId, now },
      );
    }

    if (segments.length === 2 && segments[0] === "notes") {
      return handleNoteId(req, { notes }, segments[1]);
    }

    return jsonResponse(404, { error: "not_found" });
  };
}
