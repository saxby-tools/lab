// A markdown-it plugin that turns named HTML comments into components.
//
// GitHub and most Markdown viewers hide HTML comments, so the Markdown
// between a block's comments reads as plain Markdown there. A site
// build renders the same block through a component instead.
//
//   <!-- lab:bar-chart {"value": "Fully passing"} -->
//
//   | Model | Fully passing |
//   | ----- | ------------- |
//   | Qwen  | 23/24         |
//
//   <!-- /lab:bar-chart -->
//
//   <!-- lab:report-list /-->
//
// The grammar follows WordPress block comments: a namespaced name,
// optional strict-JSON options, a `/name` closer, and `/-->` for a
// block with no content. Only comments in the plugin's namespace are
// read; every other comment passes through untouched.
//
// Mistakes stop the build instead of falling back quietly: an unknown
// component, bad JSON, a misspelled closer, a block left open, or a
// block that opens and closes at different nesting levels.
//
//   md.use(commentBlocks, {
//     namespace: "lab",
//     components: { "bar-chart": (block) => "<figure>…</figure>" },
//   });

// ---- Constants --------------------------------------------------------

const DEFAULT_NAMESPACE = "lab";

const NAME = "[a-z][a-z0-9-]*";

const TOKEN_TYPE = "comment_block";

// ---- Errors -----------------------------------------------------------

export class CommentBlockError extends Error {
  constructor(message, line, env) {
    const file = env?.page?.inputPath;
    const where = file ? `${file}:${line}` : `line ${line}`;

    super(`${where}: ${message}`);
    this.name = "CommentBlockError";
    this.line = line;
  }
}

// ---- Grammar ----------------------------------------------------------

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPatterns(namespace) {
  const ns = escapeRegex(namespace);

  return {
    ours: new RegExp(`^<!--\\s*\\/?${ns}:`),
    open: new RegExp(
      `^<!--\\s*${ns}:(${NAME})(?:\\s+(\\{[\\s\\S]*\\}))?\\s*(\\/)?-->$`,
    ),
    close: new RegExp(`^<!--\\s*\\/${ns}:(${NAME})\\s*-->$`),
  };
}

// The grammar only accepts `{...}`, so valid JSON here is an object.
function parseOptions(json, name, line, env) {
  if (json === undefined) {
    return {};
  }

  try {
    return JSON.parse(json);
  } catch (error) {
    throw new CommentBlockError(
      `"${name}" options are not valid JSON: ${error.message}`,
      line,
      env,
    );
  }
}

// Returns null for any token that is not one of our comments.
function readTag(token, patterns, env) {
  if (token.type !== "html_block") {
    return null;
  }

  const text = token.content.trim();

  if (!patterns.ours.test(text)) {
    return null;
  }

  const line = token.map ? token.map[0] + 1 : 0;
  const level = token.level;
  const close = text.match(patterns.close);

  if (close) {
    return { kind: "close", name: close[1], line, level };
  }

  const open = text.match(patterns.open);

  if (!open) {
    throw new CommentBlockError(
      `malformed block comment: ${text}`,
      line,
      env,
    );
  }

  const [, name, json, slash] = open;
  const options = parseOptions(json, name, line, env);
  const kind = slash ? "void" : "open";

  return { kind, name, options, line, level };
}

// ---- Tables -----------------------------------------------------------

// The first table among a block's own tokens, as column names and one
// object per row. Cell values are the raw Markdown source, trimmed.
function readTable(tokens) {
  const start = tokens.findIndex((token) => token.type === "table_open");

  if (start === -1) {
    return null;
  }

  const columns = [];
  const rows = [];
  let row = null;
  let inHead = false;

  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === "table_close") {
      break;
    }

    if (token.type === "thead_open") {
      inHead = true;
      continue;
    }

    if (token.type === "thead_close") {
      inHead = false;
      continue;
    }

    if (token.type === "tr_open") {
      row = [];
      continue;
    }

    if (token.type === "tr_close") {
      if (!inHead) {
        rows.push(row);
      }
      continue;
    }

    if (token.type !== "inline") {
      continue;
    }

    if (inHead) {
      columns.push(token.content.trim());
      continue;
    }

    row.push(token.content.trim());
  }

  return {
    columns,
    rows: rows.map((cells) => {
      return Object.fromEntries(
        columns.map((column, i) => [column, cells[i] ?? ""]),
      );
    }),
  };
}

// ---- Parsing ----------------------------------------------------------

function blockToken(state, tag, children) {
  const token = new state.Token(TOKEN_TYPE, "", 0);

  token.block = true;
  token.level = tag.level;
  token.meta = {
    name: tag.name,
    options: tag.options,
    line: tag.line,
    children,
  };

  return token;
}

function checkComponent(components, tag, env) {
  if (Object.hasOwn(components, tag.name)) {
    return;
  }

  throw new CommentBlockError(
    `unknown component "${tag.name}"`,
    tag.line,
    env,
  );
}

function checkClose(open, close, env) {
  if (open === null) {
    throw new CommentBlockError(
      `"/${close.name}" closes a block that was never opened`,
      close.line,
      env,
    );
  }

  if (open.name !== close.name) {
    throw new CommentBlockError(
      `"/${close.name}" does not match "${open.name}", ` +
        `opened on line ${open.line}`,
      close.line,
      env,
    );
  }

  if (open.level !== close.level) {
    throw new CommentBlockError(
      `"${open.name}" opens and closes at different nesting levels; ` +
        `keep both comments in the same list item or quote`,
      close.line,
      env,
    );
  }
}

function collapseBlocks(state, patterns, components) {
  const env = state.env;
  const root = { tag: null, tokens: [] };
  const stack = [root];

  for (const token of state.tokens) {
    const tag = readTag(token, patterns, env);
    const top = stack.at(-1);

    if (tag === null) {
      top.tokens.push(token);
      continue;
    }

    if (tag.kind === "close") {
      checkClose(top.tag, tag, env);
      stack.pop();
      stack.at(-1).tokens.push(blockToken(state, top.tag, top.tokens));
      continue;
    }

    checkComponent(components, tag, env);

    if (tag.kind === "void") {
      top.tokens.push(blockToken(state, tag, []));
      continue;
    }

    stack.push({ tag, tokens: [] });
  }

  if (stack.length > 1) {
    const open = stack.at(-1).tag;

    throw new CommentBlockError(
      `"${open.name}" is never closed; add <!-- /...:${open.name} -->`,
      open.line,
      env,
    );
  }

  state.tokens = root.tokens;
}

// ---- Plugin -----------------------------------------------------------

export default function commentBlocks(md, options = {}) {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const components = options.components ?? {};
  const patterns = buildPatterns(namespace);

  md.core.ruler.after("inline", TOKEN_TYPE, (state) => {
    collapseBlocks(state, patterns, components);
  });

  md.renderer.rules[TOKEN_TYPE] = (tokens, idx, mdOptions, env, self) => {
    const { name, options: blockOptions, line, children } = tokens[idx].meta;

    return components[name]({
      name,
      options: blockOptions,
      line,
      env,
      html: self.render(children, mdOptions, env),
      table: readTable(children),
    });
  };
}
