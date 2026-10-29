export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface HandlerOptions {
  now?: () => Date;
}

export function createHandler(options?: HandlerOptions): (req: Request) => Promise<Response> {
  const notes = new Map<string, Note>();
  let nextId = 1;
  const nowFn = options?.now ?? (() => new Date());

  const buildJsonResponse = (
    body: unknown,
    init?: ResponseInit,
  ): Response => {
    const responseInit: ResponseInit = {
      ...init,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(init?.headers ?? {}),
      },
    };
    return new Response(JSON.stringify(body), responseInit);
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Normalize path: remove trailing slash for matching
    const normalizedPath = pathname.replace(/\/+$/, '');
    const segments = normalizedPath.split('/').filter((s) => s.length > 0);

    // Check if this is the /notes collection route
    const isNotesCollection = segments.length === 1 && segments[0] === 'notes';

    // Check if this is the /notes/:id route
    const isNoteDetail = segments.length === 2 && segments[0] === 'notes';
    const noteId = isNoteDetail ? segments[1] : undefined;

    if (isNotesCollection) {
      if (req.method === 'GET') {
        const allNotes = Array.from(notes.values());
        // Sort by id (which represents creation order)
        allNotes.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
        return buildJsonResponse(allNotes);
      }

      if (req.method === 'POST') {
        let jsonData: unknown;
        const text = await req.text();

        try {
          if (text.trim() === '') {
            throw new Error('Invalid JSON');
          }
          jsonData = JSON.parse(text);
        } catch {
          return buildJsonResponse({ error: 'invalid_json' }, { status: 400 });
        }

        const validationErrors: string[] = [];

        // Treat non-objects (null, arrays, strings, numbers) as objects with no keys
        if (jsonData === null || typeof jsonData !== 'object' || Array.isArray(jsonData)) {
          validationErrors.push('title');
        } else {
          const obj = jsonData as Record<string, unknown>;

          // Validate title (required)
          const title = obj.title;
          if (typeof title !== 'string') {
            validationErrors.push('title');
          } else {
            const trimmedTitle = title.trim();
            if (trimmedTitle.length < 1 || trimmedTitle.length > 100) {
              validationErrors.push('title');
            }
          }

          // Validate body (optional, but checked if present)
          if ('body' in obj) {
            const body = obj.body;
            if (typeof body !== 'string') {
              validationErrors.push('body');
            } else if (body.length > 10000) {
              validationErrors.push('body');
            }
          }
        }

        if (validationErrors.length > 0) {
          return buildJsonResponse(
            { error: 'validation', fields: validationErrors },
            { status: 422 },
          );
        }

        // All validations passed, create the note
        const obj = jsonData as Record<string, unknown>;
        const title = typeof obj.title === 'string' ? obj.title!.trim() : '';
        const body = typeof obj.body === 'string' ? obj.body! : '';

        const note: Note = {
          id: String(nextId++),
          title,
          body,
          createdAt: nowFn().toISOString(),
        };

        notes.set(note.id, note);

        return new Response(JSON.stringify(note), {
          status: 201,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Location: `/notes/${note.id}`,
          },
        });
      }

      // Method not allowed for other methods on /notes
      return buildJsonResponse({ error: 'method_not_allowed' }, {
        status: 405,
        headers: { Allow: 'GET, POST' },
      });
    }

    if (isNoteDetail) {
      const id = noteId!;

      if (req.method === 'GET') {
        const note = notes.get(id);
        if (!note) {
          return buildJsonResponse({ error: 'not_found' }, { status: 404 });
        }
        return buildJsonResponse(note);
      }

      if (req.method === 'DELETE') {
        if (!notes.has(id)) {
          return buildJsonResponse({ error: 'not_found' }, { status: 404 });
        }
        notes.delete(id);
        return new Response(null, { status: 204 });
      }

      // Method not allowed for other methods on /notes/:id
      return buildJsonResponse({ error: 'method_not_allowed' }, {
        status: 405,
        headers: { Allow: 'GET, DELETE' },
      });
    }

    // Unknown route
    return buildJsonResponse({ error: 'not_found' }, { status: 404 });
  };
}
