// A table of calls, with each judge's pick drawn as a colored pill and
// the rows where judges disagree shaded.
//
//   <!-- lab:verdicts {"judges": ["Judge 1", "Judge 2"]} -->
//
//   | Task | Judge 1 | Judge 2 | What decided it |
//   | debounce | Qwen | Qwen (high) | Both caught ... |
//
// A pick may carry a confidence in parentheses. The first column heads
// each row; columns that aren't judges stay as written.
//
// Options:
//   judges  the columns holding picks (required)
//
// Any paragraph after the table becomes the caption.

import {
  captionOf,
  fail,
  requireColumns,
  requireTable,
  seriesClass,
} from "./shared.js";

// ---- Constants --------------------------------------------------------

const PICK = /^(.+?)(?:\s*\(([^)]+)\))?$/;

// ---- Table ------------------------------------------------------------

function readPick(block, text) {
  const [, name, confidence] = text.match(PICK);

  return {
    name,
    confidence: confidence ?? null,
    series: seriesClass(block, name),
  };
}

export default function verdicts(block) {
  const table = requireTable(block);
  const judges = block.options.judges;

  if (!Array.isArray(judges) || judges.length === 0) {
    fail(block, 'needs a "judges" option listing the pick columns');
  }

  requireColumns(block, judges);

  const [head, ...rest] = table.columns;

  return {
    head,
    columns: rest,
    caption: captionOf(block.html),
    rows: table.rows.map((row, i) => {
      const picks = Object.fromEntries(judges.map((judge) => {
        return [judge, readPick(block, row[judge])];
      }));
      const names = new Set(Object.values(picks).map((pick) => pick.name));

      return {
        name: row[head],
        split: names.size > 1,
        cells: rest.map((column) => {
          return {
            pick: picks[column] ?? null,
            html: table.htmlRows[i][column],
          };
        }),
      };
    }),
  };
}
