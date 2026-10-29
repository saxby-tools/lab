export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

interface JsonResponse {
  status: number;
  body: unknown;
  headers?: HeadersInit;
}

function jsonResponse(options: JsonResponse): Response {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(options.body), {
    status: options.status,
    headers,
  });
}

function parsePathname(pathname: string): string[] {
  const cleaned = pathname.replace(/\/+$/, "");
  const segments = cleaned.split("/").filter((segment) => segment !== "");
  return segments;
}

export function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const now = options?.now ?? (() => new Date());
  const store: Map<string, Note> = new Map();
  let nextId = 1;

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const segments = parsePathname(url.pathname);

    if (segments.length === 1 && segments[0] === "notes") {
      switch (req.method) {
        case "GET": {
          const notes = Array.from(store.values());
          return jsonResponse({ status: 200, body: notes });
        }
        case "POST": {
          let parsed: unknown;
          try {
            parsed = await req.json();
          } catch (_error) {
            return jsonResponse({
              status: 400,
              body: { error: "invalid_json" },
            });
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            parsed = {};
          }
          const candidate = parsed as Record<string, unknown>;
          const fields: string[] = [];
          const title = candidate.title;
          if (
            typeof title !== "string" ||
            title.trim().length < 1 ||
            title.trim().length > 100
          ) {
            fields.push("title");
          }
          const body =
            candidate.body === undefined ? "" : candidate.body;
          if (typeof body !== "string" || body.length > 10000) {
            fields.push("body");
          }
          if (fields.length > 0) {
            return jsonResponse({
              status: 422,
              body: { error: "validation", fields },
            });
          }
          const id = String(nextId++);
          const createdAt = now().toISOString();
          const note: Note = {
            id,
            title: title.trim(),
            body: body as string,
            createdAt,
          };
          store.set(id, note);
          return jsonResponse({
            status: 201,
            body: note,
            headers: { Location: `/notes/${id}` },
          });
        }
        default:
          return jsonResponse({
            status: 405,
            body: { error: "method_not_allowed" },
            headers: { Allow: "GET, POST" },
          });
      }
    } else if (
      segments.length === 2 &&
      segments[0] === "notes" &&
      segments[1] !== ""
    ) {
      const id = segments[1];
      switch (req.method) {
        case "GET": {
          const note = store.get(id);
          if (!note) {
            return jsonResponse({
              status: 404,
              body: { error: "not_found" },
            });
          }
          return jsonResponse({ status: 200, body: note });
        }
        case "DELETE": {
          const existed = store.delete(id);
          if (!existed) {
            return jsonResponse({
              status: 404,
              body: { error: "not_found" },
            });
          }
          return new Response(null, { status: 204 });
        }
        default:
          return jsonResponse({
            status: 405,
            body: { error: "method_not_allowed" },
            headers: { Allow: "GET, DELETE" },
          });
      }
    } else {
      return jsonResponse({ status: 404, body: { error: "not_found" } });
    }
  };

  return handler;
}
