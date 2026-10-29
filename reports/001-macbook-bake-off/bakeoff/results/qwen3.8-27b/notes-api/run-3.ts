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
  const store: Note[] = [];
  let nextId = 1;
  const nowFn = options?.now ?? (() => new Date());

  const jsonCt = { "Content-Type": "application/json; charset=utf-8" };

  function json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: jsonCt,
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Allow one trailing slash
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    const segments = pathname.split("/").filter((s) => s.length > 0);
    const method = req.method;

    // /notes
    if (segments.length === 1 && segments[0] === "notes") {
      if (method === "GET") {
        return json(200, store);
      }

      if (method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await req.text());
        } catch {
          return json(400, { error: "invalid_json" });
        }

        // Treat non-object JSON values as an empty object (no keys)
        let obj: Record<string, unknown> = {};
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          obj = parsed as Record<string, unknown>;
        }

        const fields: string[] = [];

        // Validate title
        if (
          typeof obj.title !== "string" ||
          obj.title.trim().length < 1 ||
          obj.title.trim().length > 100
        ) {
          fields.push("title");
        }

        // Validate body (only when present)
        if (
          "body" in obj &&
          (typeof obj.body !== "string" || (obj.body as string).length > 10000)
        ) {
          fields.push("body");
        }

        if (fields.length > 0) {
          return json(422, { error: "validation", fields });
        }

        const id = String(nextId++);
        const note: Note = {
          id,
          title: obj.title!.trim(),
          body: "body" in obj ? obj.body as string : "",
          createdAt: nowFn().toISOString(),
        };
        store.push(note);

        return new Response(JSON.stringify(note), {
          status: 201,
          headers: {
            ...jsonCt,
            Location: `/notes/${id}`,
          },
        });
      }

      // Unsupported method on /notes
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { ...jsonCt, Allow: "GET, POST" },
      });
    }

    // /notes/:id
    if (segments.length === 2 && segments[0] === "notes") {
      const id = segments[1];

      if (method === "GET" || method === "DELETE") {
        const idx = store.findIndex((n) => n.id === id);
        if (idx === -1) {
          return json(404, { error: "not_found" });
        }

        if (method === "DELETE") {
          store.splice(idx, 1);
          return new Response(null, { status: 204 });
        }

        return json(200, store[idx]);
      }

      // Unsupported method on /notes/:id
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { ...jsonCt, Allow: "GET, DELETE" },
      });
    }

    // Unknown path
    return json(404, { error: "not_found" });
  };
}
