// A markdown-it plugin that points relative links to Markdown files at
// the pages built from them: `data.md#known-gaps` becomes
// `data.html#known-gaps`. The Markdown keeps working links on GitHub,
// and the site keeps working links too.
//
// It pairs with a permalink of `<file path without .md>.html`. Links
// with a scheme (`https:`, `mailto:`) or a leading `/` are left alone.

// ---- Constants --------------------------------------------------------

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const MARKDOWN_PATH = /\.md$/i;

// ---- Rewriting --------------------------------------------------------

function rewriteHref(href) {
  if (SCHEME.test(href)) {
    return href;
  }

  if (href.startsWith("/")) {
    return href;
  }

  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const rest = cut === -1 ? "" : href.slice(cut);

  if (!MARKDOWN_PATH.test(path)) {
    return href;
  }

  return path.replace(MARKDOWN_PATH, ".html") + rest;
}

// Comment blocks keep their content in `meta.children`, so look there
// too, or links inside a block would be missed.
function rewriteTokens(tokens) {
  for (const token of tokens) {
    if (token.children) {
      rewriteTokens(token.children);
    }

    if (Array.isArray(token.meta?.children)) {
      rewriteTokens(token.meta.children);
    }

    if (token.type !== "link_open") {
      continue;
    }

    const href = token.attrGet("href");

    if (href === null) {
      continue;
    }

    token.attrSet("href", rewriteHref(href));
  }
}

// ---- Plugin -----------------------------------------------------------

export default function mdLinks(md) {
  md.core.ruler.push("md_links", (state) => {
    rewriteTokens(state.tokens);
  });
}
