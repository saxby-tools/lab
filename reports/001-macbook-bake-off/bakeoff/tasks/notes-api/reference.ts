// ---- Constants --------------------------------------------------------

const JSON_TYPE = "application/json; charset=utf-8";

const TITLE_MAX = 100;

const BODY_MAX = 10_000;

const COLLECTION_ALLOW = "GET, POST";

const ITEM_ALLOW = "GET, DELETE";

// ---- Types ------------------------------------------------------------

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

// ---- Responses --------------------------------------------------------

function json(status: number, data: unknown, headers = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": JSON_TYPE, ...headers },
  });
}

function notFound(): Response {
  return json(404, { error: "not_found" });
}

function notAllowed(allow: string): Response {
  return json(405, { error: "method_not_allowed" }, { allow });
}

// ---- Parsing ----------------------------------------------------------

function segmentsOf(pathname: string): string[] {
  let path = pathname;

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path.split("/").slice(1);
}

type Parsed = { ok: boolean; value?: unknown };

async function readJson(req: Request): Promise<Parsed> {
  const text = await req.text();

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null) {
    return {};
  }

  if (typeof value !== "object") {
    return {};
  }

  if (Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function invalidFields(input: Record<string, unknown>): string[] {
  const fields: string[] = [];
  const title = input.title;

  const titleOk = typeof title === "string" &&
    title.trim().length >= 1 &&
    title.trim().length <= TITLE_MAX;

  if (!titleOk) {
    fields.push("title");
  }

  const body = input.body;

  const bodyOk = body === undefined ||
    (typeof body === "string" && body.length <= BODY_MAX);

  if (!bodyOk) {
    fields.push("body");
  }

  return fields;
}

// ---- Handler ----------------------------------------------------------

export function createHandler(
  options: HandlerOptions = {},
): (req: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const notes = new Map<string, Note>();
  let nextId = 1;

  async function create(req: Request): Promise<Response> {
    const parsed = await readJson(req);

    if (!parsed.ok) {
      return json(400, { error: "invalid_json" });
    }

    const input = asRecord(parsed.value);
    const fields = invalidFields(input);

    if (fields.length > 0) {
      return json(422, { error: "validation", fields });
    }

    const note: Note = {
      id: String(nextId),
      title: (input.title as string).trim(),
      body: (input.body as string | undefined) ?? "",
      createdAt: now().toISOString(),
    };

    nextId += 1;
    notes.set(note.id, note);

    return json(201, note, { location: `/notes/${note.id}` });
  }

  function collection(req: Request): Promise<Response> | Response {
    if (req.method === "GET") {
      return json(200, [...notes.values()]);
    }

    if (req.method === "POST") {
      return create(req);
    }

    return notAllowed(COLLECTION_ALLOW);
  }

  function item(req: Request, id: string): Response {
    const note = notes.get(id);

    if (req.method !== "GET" && req.method !== "DELETE") {
      return notAllowed(ITEM_ALLOW);
    }

    if (!note) {
      return notFound();
    }

    if (req.method === "GET") {
      return json(200, note);
    }

    notes.delete(id);

    return new Response(null, { status: 204 });
  }

  return async (req: Request): Promise<Response> => {
    const segments = segmentsOf(new URL(req.url).pathname);

    if (segments[0] !== "notes") {
      return notFound();
    }

    if (segments.length === 1) {
      return await collection(req);
    }

    if (segments.length === 2 && segments[1] !== "") {
      return item(req, segments[1]);
    }

    return notFound();
  };
}
