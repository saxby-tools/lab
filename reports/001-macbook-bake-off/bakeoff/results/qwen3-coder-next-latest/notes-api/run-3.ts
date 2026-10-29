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
  const now = options?.now ?? (() => new Date());
  const store: Note[] = [];
  let nextId = 1;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Normalize pathname: remove trailing slash (except for root)
    let normalizedPathname = pathname;
    if (normalizedPathname !== "/" && normalizedPathname.endsWith("/")) {
      normalizedPathname = normalizedPathname.slice(0, -1);
    }

    // Handle /notes and /notes/:id routes
    if (normalizedPathname === "/notes") {
      switch (req.method) {
        case "GET":
          return new Response(JSON.stringify(store), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });

        case "POST":
          let bodyObj;
          try {
            const body = await req.text();
            bodyObj = body ? JSON.parse(body) : {};
          } catch {
            return new Response(JSON.stringify({ error: "invalid_json" }), {
              status: 400,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            });
          }

          // If not an object, treat as validation error with no fields
          if (typeof bodyObj !== "object" || bodyObj === null || Array.isArray(bodyObj)) {
            return new Response(
              JSON.stringify({ error: "validation", fields: [] }),
              { status: 422, headers: { "Content-Type": "application/json; charset=utf-8" } },
            );
          }

          // Extract fields
          const title = bodyObj.title;
          const body = bodyObj.body;

          // Validation
          const fields: string[] = [];
          let titleValue: string;

          if (typeof title !== "string") {
            fields.push("title");
          } else {
            const trimmedTitle = title.trim();
            if (trimmedTitle.length < 1 || trimmedTitle.length > 100) {
              fields.push("title");
            } else {
              titleValue = trimmedTitle;
            }
          }

          let bodyValue: string = "";
          if (body !== undefined && body !== null) {
            if (typeof body !== "string") {
              fields.push("body");
            } else if (body.length > 10000) {
              fields.push("body");
            } else {
              bodyValue = body;
            }
          }

          // If validation errors, return them
          if (fields.length > 0) {
            return new Response(
              JSON.stringify({ error: "validation", fields }),
              { status: 422, headers: { "Content-Type": "application/json; charset=utf-8" } },
            );
          }

          // Create note
          const id = String(nextId++);
          const note: Note = {
            id,
            title: titleValue,
            body: bodyValue,
            createdAt: now().toISOString(),
          };
          store.push(note);

          return new Response(JSON.stringify(note), {
            status: 201,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Location": `/notes/${id}`,
            },
          });

        default:
          return new Response(
            JSON.stringify({ error: "method_not_allowed" }),
            {
              status: 405,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Allow": "GET, POST",
              },
            },
          );
      }
    } else {
      // Handle /notes/:id paths
      const pathParts = normalizedPathname.split("/");
      if (
        pathParts.length === 3 &&
        pathParts[1] === "notes" &&
        pathParts[2].length > 0
      ) {
        const id = pathParts[2];
        switch (req.method) {
          case "GET":
            const note = store.find((note) => note.id === id);
            if (!note) {
              return new Response(JSON.stringify({ error: "not_found" }), {
                status: 404,
                headers: { "Content-Type": "application/json; charset=utf-8" },
              });
            }
            return new Response(JSON.stringify(note), {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            });

          case "DELETE":
            const index = store.findIndex((note) => note.id === id);
            if (index === -1) {
              return new Response(JSON.stringify({ error: "not_found" }), {
                status: 404,
                headers: { "Content-Type": "application/json; charset=utf-8" },
              });
            }
            store.splice(index, 1);
            return new Response(null, { status: 204 });

          default:
            return new Response(
              JSON.stringify({ error: "method_not_allowed" }),
              {
                status: 405,
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  "Allow": "GET, DELETE",
                },
              },
            );
        }
      } else {
        // Unknown path
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }
  };
}
