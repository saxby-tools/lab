// Prepares a bar chart from the Markdown table inside its block.
//
//   <!-- lab:bar-chart {"value": "Fully passing", "title": "..."} -->
//
// Options:
//   value  the column holding each bar's number (required)
//   label  the column naming each bar (default: the first column)
//   title  a caption above the chart
//   max    the scale's top (default: the largest "/N", else the
//          largest value)
//
// Cells read as a leading number with an optional "/max" and unit, so
// "23/24", "17.2 GiB" and "96%" all work. A cell that isn't a number
// stops the build; a chart that silently drops a row would lie.

import { CommentBlockError } from "../plugins/comment-blocks.js";

// ---- Constants --------------------------------------------------------

const CELL = /^(-?\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*(.*)$/;

// ---- Cells ------------------------------------------------------------

export function parseCell(text) {
  const match = text.trim().replace(/,/g, "").match(CELL);

  if (!match) {
    return null;
  }

  const [, value, max, unit] = match;

  return {
    value: Number(value),
    max: max === undefined ? null : Number(max),
    unit: unit.trim(),
  };
}

// ---- Chart ------------------------------------------------------------

function fail(block, message) {
  throw new CommentBlockError(
    `bar-chart: ${message}`,
    block.line,
    block.env,
  );
}

function scaleTop(block, cells) {
  if (block.options.max !== undefined) {
    return block.options.max;
  }

  const tops = cells.map((cell) => cell.max ?? cell.value);

  return Math.max(...tops);
}

export default function barChart(block) {
  const { table, options } = block;

  if (table === null) {
    fail(block, "needs a Markdown table inside the block");
  }

  if (options.value === undefined) {
    fail(block, 'needs a "value" option naming a column');
  }

  const label = options.label ?? table.columns[0];

  for (const column of [label, options.value]) {
    if (!table.columns.includes(column)) {
      fail(block, `no column named "${column}"`);
    }
  }

  const cells = table.rows.map((row) => {
    const cell = parseCell(row[options.value]);

    if (cell === null) {
      fail(block, `"${row[options.value]}" in "${row[label]}" isn't a number`);
    }

    return cell;
  });

  const top = scaleTop(block, cells);

  return {
    title: options.title ?? null,
    html: block.html,
    rows: table.rows.map((row, i) => {
      const share = top > 0 ? cells[i].value / top : 0;

      return {
        name: row[label],
        text: row[options.value],
        percent: Math.min(100, Math.max(0, share * 100)).toFixed(1),
      };
    }),
  };
}
