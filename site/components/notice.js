// A boxed aside with a small kicker above its heading.
//
//   <!-- lab:notice {"kicker": "Fun fact", "id": "ff"} -->
//
//   ### Where “bake-off” comes from
//
//   ...
//
//   <!-- /lab:notice -->
//
// The first heading inside labels the aside for screen readers.

import { fail } from "./shared.js";

// ---- Constants --------------------------------------------------------

const HEADING = /<h([2-6])>/;

// ---- Notice -----------------------------------------------------------

export default function notice(block) {
  const id = `${block.options.id ?? "notice"}-t`;
  const heading = block.html.match(HEADING);

  if (!heading) {
    fail(block, "needs a heading inside the block");
  }

  return {
    id,
    kicker: block.options.kicker ?? null,
    html: block.html.replace(HEADING, `<h${heading[1]} id="${id}">`),
  };
}
