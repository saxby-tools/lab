export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

function createHandler(
  options?: HandlerOptions,
): (req: Request) => Promise<Response> {
  const notes = new Map<string, Note>();
  let nextId = 1;
  const now = options?.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const segments = pathname.split('/').filter(s => s);

    let route: 'collection' | 'item' | null = null;
    let noteId: string | undefined;

    const firstSegment = segments[0];
    if (firstSegment === 'notes') {
      if (segments.length === 1) {
        route = 'collection';
      } else if (segments.length === 2) {
        route = 'item';
        noteId = segments[1];
      } else {
        route = null;
      }
    }

    if (route === null) {
      return makeNotFoundResponse();
    }

    const method = req.method;

    try {
      if (route === 'collection') {
        if (method === 'GET') {
          return makeJsonResponse(Array.from(notes.values()));
        } else if (method === 'POST') {
          const body = await req.text();
          let jsonData: unknown;
          try {
            jsonData = JSON.parse(body);
          } catch (e) {
            return makeErrorBody(400, 'invalid_json');
          }

          const errors: string[] = [];
          const title = (jsonData as Record<string, any>).title;
          const bodyField = (jsonData as Record<string, any>).body;

          if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > 100) {
            errors.push('title');
          }

          if (bodyField !== undefined && typeof bodyField !== 'string') {
            errors.push('body');
          } else if (bodyField !== undefined && bodyField.length > 10000) {
            errors.push('body');
          }

          if (errors.length > 0) {
            return makeErrorBody(422, 'validation', errors);
          }

          const newNote: Note = {
            id: nextId.toString(),
            title: title ? title.trim() : '',
            body: typeof bodyField === 'string' ? bodyField : '',
            createdAt: now().toISOString(),
          };

          nextId++;
          notes.set(newNote.id, newNote);

          return new Response(
            JSON.stringify(newNote),
            {
              status: 201,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Location': `/notes/${newNote.id}`,
              },
            }
          );
        } else {
          return makeMethodNotAllowed('GET, POST');
        }
      } else if (route === 'item') {
        const existingNote = notes.get(noteId!);
        if (!existingNote) {
          return makeNotFoundResponse();
        }

        if (method === 'GET') {
          return makeJsonResponse(existingNote);
        } else if (method === 'DELETE') {
          notes.delete(noteId!);
          return new Response(null, { status: 204 });
        } else {
          return makeMethodNotAllowed('GET, DELETE');
        }
      }
    } catch (e) {
      return makeNotFoundResponse();
    }

    return makeNotFoundResponse();
  };
}

function makeJsonResponse(data: any): Response {
  return new Response(
    JSON.stringify(data),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );
}

function makeErrorBody(
  status: number,
  errorType: string,
  fields?: string[]
): Response {
  const body: { error: string; fields?: string[] } = { error: errorType };
  if (fields) {
    body.fields = fields;
  }
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );
}

function makeNotFoundResponse(): Response {
  return makeErrorBody(404, 'not_found');
}

function makeMethodNotAllowed(allowMethods: string): Response {
  return new Response(
    JSON.stringify({ error: 'method_not_allowed' }),
    {
      status: 405,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Allow: allowMethods,
      },
    }
  );
}
