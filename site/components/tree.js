// A folder's files as a tree, from a list where each item starts with
// a name in code:
//
//   <!-- lab:tree {"root": "reports/001-macbook-bake-off/"} -->
//
//   - `index.md`: The report itself, in Markdown.
//
//   <!-- /lab:tree -->
//
// Options:
//   root  the folder shown above the tree

import { fail } from "./shared.js";

// ---- Constants --------------------------------------------------------

const ITEM = /<li>([\s\S]*?)<\/li>/g;

const NAME = /^\s*<code>([\s\S]+?)<\/code>\s*(?:[—–:-]\s*)?/;

// ---- Tree -------------------------------------------------------------

export default function tree(block) {
  const items = [...block.html.matchAll(ITEM)].map((match) => match[1]);

  if (items.length === 0) {
    fail(block, "needs a list, one item per file");
  }

  return {
    root: block.options.root ?? null,
    items: items.map((item) => {
      const name = item.match(NAME);

      if (!name) {
        fail(block, "each item must start with a name in code");
      }

      return { name: name[1], text: item.slice(name[0].length).trim() };
    }),
  };
}
