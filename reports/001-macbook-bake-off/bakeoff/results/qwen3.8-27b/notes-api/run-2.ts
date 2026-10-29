export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

const CT = "application/json; charset=utf-8";

function json(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = { "Content-Type": CT };
  for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  return new Response(JSON.stringify(body), { status, headers });
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const now: () => Date = options?.now ?? (() => new Date());
  const notes: Note[] = [];
  let nextId = 1;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let path = url.pathname;

    // Allow one trailing slash
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    const segments = path.split("/").filter((s) => s.length > 0);
    const method = req.method;

    // ── /notes ──────────────────────────────────────────────
    if (segments.length === 1 && segments[0] === "notes") {
      if (method === "GET") {
        return json(200, notes);
      }
      if (method === "POST") {
        return handlePost(req, now);
      }
      return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
    }

    // ── /notes/:id ──────────────────────────────────────────
    if (segments.length === 2 && segments[0] === "notes" && segments[1].length > 0) {
      const id = segments[1];

      if (method === "GET") {
        const note = notes.find((n) => n.id === id);
        if (!note) return json(404, { error: "not_found" });
        return json(200, note);
      }

      if (method === "DELETE") {
        const idx = notes.findIndex((n) => n.id === id);
        if (idx === -1) return json(404, { error: "not_found" });
        notes.splice(idx, 1);
        return new Response(null, { status: 204 });
      }

      return json(405, { error: "method_not_allowed" }, {
        Allow: "GET, DELETE",
      });
    }

    // ── Unknown path ────────────────────────────────────────
    return json(404, { error: "not_found" });

    // ── POST handler ────────────────────────────────────────
    async function handlePost(r: Request, nowFn: () => Date): Promise<Response> {
      // Parse JSON body
      let parsed: unknown;
      try {
        const text = await r.text();
        parsed = JSON.parse(text);
      } catch {
        return json(400, { error: "invalid_json" });
      }

      // Determine the object to read fields from.
      // Arrays, null, primitives are treated as an object with no keys.
      const obj: Record<string, unknown> =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};

      const fields: string[] = [];

      // Validate title
      let titleValid = false;
      let trimmedTitle = "";
      if (typeof obj.title === "string") {
        trimmedTitle = obj.title.trim();
        if (trimmedTitle.length >= 1 && trimmedTitle.length <= 100) {
          titleValid = true;
        }
      }
      if (!titleValid) {
        fields.push("title");
      }

      // Validate body
      let bodyValid = true;
      let bodyValue = "";
      if ("body" in obj) {
        if (typeof obj.body !== "string" || obj.body.length > 10_000) {
          bodyValid = false;
        } else {
          bodyValue = obj.body;
        }
      }
      if (!bodyValid) {
        fields.push("body");
      }

      if (fields.length > 0) {
        return json(422, { error: "validation", fields });
      }

      // Create the note
      const id = String(nextId++);
      const note: Note = {
        id,
        title: trimmedTitle,
        body: bodyValue,
        createdAt: nowFn().toISOString(),
      };
      notes.push(note);

      return json(201, note, { Location: `/notes/${id}` });
    }
  };
}
