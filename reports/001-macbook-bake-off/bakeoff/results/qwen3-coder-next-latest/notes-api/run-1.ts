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
  const notes: Note[] = [];
  const now = options?.now ?? (() => new Date());
  let nextId = 1;

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    
    // Normalize pathname: remove trailing slash unless it's root
    let normalizedPathname = pathname;
    if (normalizedPathname.length > 1 && normalizedPathname.endsWith('/')) {
      normalizedPathname = normalizedPathname.slice(0, -1);
    }

    // Route: /notes
    if (normalizedPathname === '/notes') {
      switch (req.method) {
        case 'GET':
          return handleGetNotes();
        case 'POST':
          return handleCreateNote(req);
        default:
          return handleMethodNotAllowed(['GET', 'POST']);
      }
    }

    // Route: /notes/:id
    const notesIdMatch = normalizedPathname.match(/^\/notes\/([^/]+)$/);
    if (notesIdMatch) {
      const id = notesIdMatch[1];
      switch (req.method) {
        case 'GET':
          return handleGetNote(id);
        case 'DELETE':
          return handleDeleteNote(id);
        default:
          return handleMethodNotAllowed(['GET', 'DELETE']);
      }
    }

    // Unknown path
    return handleNotFound();
  }

  function handleGetNotes(): Response {
    return new Response(JSON.stringify(notes), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  async function handleCreateNote(req: Request): Promise<Response> {
    let body: any;
    try {
      const text = await req.text();
      if (text.trim() === '') {
        throw new Error('Empty body');
      }
      body = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const fields: string[] = [];
    
    // Validate title
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof body.title !== 'string' ||
      body.title.trim().length === 0 ||
      body.title.trim().length > 100
    ) {
      fields.push('title');
    }

    // Validate body if present
    if (body.body !== undefined) {
      if (
        typeof body.body !== 'string' ||
        body.body.length > 10000
      ) {
        fields.push('body');
      }
    }

    if (fields.length > 0) {
      return new Response(JSON.stringify({ error: 'validation', fields }), {
        status: 422,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const noteId = String(nextId++);
    const note: Note = {
      id: noteId,
      title: body.title.trim(),
      body: body.body ?? '',
      createdAt: now().toISOString(),
    };

    notes.push(note);

    return new Response(JSON.stringify(note), {
      status: 201,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Location': `/notes/${noteId}`,
      },
    });
  }

  function handleGetNote(id: string): Response {
    const note = notes.find(n => n.id === id);
    if (!note) {
      return handleNotFound();
    }

    return new Response(JSON.stringify(note), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  function handleDeleteNote(id: string): Response {
    const index = notes.findIndex(n => n.id === id);
    if (index === -1) {
      return handleNotFound();
    }

    notes.splice(index, 1);

    return new Response(null, {
      status: 204,
    });
  }

  function handleNotFound(): Response {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  function handleMethodAllowed(allowed: string[]): Response {
    return new Response(null, {
      status: 405,
      headers: {
        'Allow': allowed.join(', '),
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  function handleMethodNotAllowed(allowed: string[]): Response {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: {
        'Allow': allowed.join(', '),
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  return handleRequest;
}
