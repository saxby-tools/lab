// A list with each item's lead in bold, such as takeaways or licenses:
//
//   <!-- lab:lessons -->
//
//   - **Run your own bake-off.** Published scores picked Laguna.
//   - **CC BY-SA 4.0** — Reports, docs and recorded data.
//
//   <!-- /lab:lessons -->
//
// A dash or colon right after the lead is for GitHub readers and is
// dropped on the site.
//
// Options:
//   class  the list's class (default "lessons")

import { fail } from "./shared.js";

// ---- Constants --------------------------------------------------------

const ITEM = /<li>([\s\S]*?)<\/li>/g;

const LEAD = /^\s*<strong>([\s\S]+?)<\/strong>\s*(?:[—–:-]\s*)?/;

// ---- Lessons ----------------------------------------------------------

export default function lessons(block) {
  const items = [...block.html.matchAll(ITEM)].map((match) => match[1]);

  if (items.length === 0) {
    fail(block, "needs a list, one item per lesson");
  }

  return {
    className: block.options.class ?? "lessons",
    items: items.map((item) => {
      const lead = item.match(LEAD);

      if (!lead) {
        fail(block, "each item must start with its lead in bold");
      }

      return { lead: lead[1], text: item.slice(lead[0].length).trim() };
    }),
  };
}
