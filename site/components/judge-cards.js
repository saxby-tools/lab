// A row of cards from a list. Each item starts with its score in bold,
// then a dash, then the description:
//
//   <!-- lab:judge-cards -->
//
//   - **4–4** — **Judge 1, Claude in chat,** graded against ...
//
//   <!-- /lab:judge-cards -->

import { fail } from "./shared.js";

// ---- Constants --------------------------------------------------------

const ITEM = /<li>([\s\S]*?)<\/li>/g;

const SCORE = /^\s*<strong>([^<]+)<\/strong>\s*[—–:-]?\s*/;

// ---- Cards ------------------------------------------------------------

export default function judgeCards(block) {
  const items = [...block.html.matchAll(ITEM)].map((match) => match[1]);

  if (items.length === 0) {
    fail(block, "needs a list, one item per card");
  }

  return {
    cards: items.map((item) => {
      const score = item.match(SCORE);

      if (!score) {
        fail(block, "each item must start with its score in bold");
      }

      return {
        score: score[1].replace(/([–-])/, "<span>$1</span>"),
        text: item
          .slice(score[0].length)
          .replace(/<(\/?)strong>/g, "<$1b>")
          .trim(),
      };
    }),
  };
}
