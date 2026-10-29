// A list of takeaways, each with its lead in bold:
//
//   <!-- lab:lessons -->
//
//   - **Run your own bake-off.** Published scores picked Laguna.
//
//   <!-- /lab:lessons -->

import { fail } from "./shared.js";

// ---- Constants --------------------------------------------------------

const ITEM = /<li>([\s\S]*?)<\/li>/g;

const LEAD = /^\s*<strong>([\s\S]+?)<\/strong>\s*/;

// ---- Lessons ----------------------------------------------------------

export default function lessons(block) {
  const items = [...block.html.matchAll(ITEM)].map((match) => match[1]);

  if (items.length === 0) {
    fail(block, "needs a list, one item per lesson");
  }

  return {
    items: items.map((item) => {
      const lead = item.match(LEAD);

      if (!lead) {
        fail(block, "each item must start with its lead in bold");
      }

      return { lead: lead[1], text: item.slice(lead[0].length).trim() };
    }),
  };
}
