export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

interface ErrorBody {
  error: string;
  fields?: string[];
}

function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  const headersObj = new Headers(headers);
  headersObj.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: headersObj });
}

function normalizePathname(pathname: string): string {
  // Remove trailing slash unless it's the root
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function matchRoute(normalized: string): { type: string; id?: string } | null {
  if (normalized === "/notes") {
    return { type: "notes" };
  }
  const singleSegmentMatch = /^\/notes\/([^/]+)$/.exec(normalized);
  if (singleSegmentMatch) {
    return { type: "note", id: singleSegmentMatch[1] };
  }
  return null;
}

export function createHandler(options?: HandlerOptions): (req: Request) => Promise<Response> {
  const store = new Map<string, Note>();
  let nextId = 1;
  const nowFn = options?.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const normalized = normalizePathname(url.pathname);
    const route = matchRoute(normalized);

    if (!route) {
      return jsonResponse(404, { error: "not_found" } as ErrorBody);
    }

    if (route.type === "notes") {
      if (req.method === "GET") {
        const notes = Array.from(store.values());
        return jsonResponse(200, notes);
      } else if (req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          return jsonResponse(400, { error: "invalid_json" } as ErrorBody);
        }

        const obj = (typeof parsed === "object" && parsed !== null) ? parsed : {};

        const errors: string[] = [];
        let title: string | undefined;
        let body: string | undefined;

        if (!Object.prototype.hasOwnProperty.call(obj, "title") ||
            typeof obj.title !== "string" ||
            obj.title.trim().length < 1 ||
            obj.title.trim().length > 100) {
          errors.push("title");
        } else {
          title = obj.title.trim();
        }

        if (Object.prototype.hasOwnProperty.call(obj, "body")) {
          if (typeof obj.body !== "string" || obj.body.length > 10000) {
            errors.push("body");
          } else {
            body = obj.body;
          }
        }

        if (errors.length > 0) {
          return jsonResponse(422, { error: "validation", fields: errors } as ErrorBody);
        }

        const id = String(nextId++);
        const createdAt = nowFn().toISOString();
        const note: Note = {
          id,
          title: title as string,
          body: body ?? "",
          createdAt,
        };
        store.set(id, note);

        return jsonResponse(201, note, { Location: `/notes/${id}` });
      } else {
        return jsonResponse(405, { error: "method_not_allowed" } as ErrorBody, {
          Allow: "GET, POST",
        });
      }
    }

    // route.type === "note"
    const id = route.id as string;

    if (req.method === "GET") {
      const note = store.get(id);
      if (!note) {
        return jsonResponse(404, { error: "not_found" } as ErrorBody);
      }
      return jsonResponse(200, note);
    } else if (req.method === "DELETE") {
      if (!store.has(id)) {
        return jsonResponse(404, { error: "not_found" } as ErrorBody);
      }
      store.delete(id);
      return new Response(null, { status: 204 });
    } else {
      return jsonResponse(405, { error: "method_not_allowed" } as ErrorBody, {
        Allow: "GET, DELETE",
      });
    }
  };
}
