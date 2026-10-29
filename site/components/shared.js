// Helpers the components share: failing with the block's file and
// line, reading numbers out of table cells, and colors per series.
//
// Colors come from a `palette` in the page's data, mapping a name as
// it appears in a table to a series number from the design system:
//
//   { "palette": { "Qwen3.8 27B": 1, "Gemma 4 31B": 2 } }
//
// A name missing from the palette gets no color class; the series
// default applies.

import { CommentBlockError } from "markdown-it-comment-blocks";

// ---- Constants --------------------------------------------------------

const CELL = /^(-?\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*(.*)$/;

const TABLE_HTML = /<table>[\s\S]*?<\/table>\n?/;

// ---- Failing ----------------------------------------------------------

export function fail(block, message) {
  throw new CommentBlockError(
    `${block.name}: ${message}`,
    block.line,
    block.env,
  );
}

export function requireTable(block) {
  if (block.table === null) {
    fail(block, "needs a Markdown table inside the block");
  }

  return block.table;
}

export function requireColumns(block, columns) {
  const table = requireTable(block);

  for (const column of columns) {
    if (!table.columns.includes(column)) {
      fail(block, `no column named "${column}"`);
    }
  }
}

// ---- Cells ------------------------------------------------------------

// "23/24", "17.2 GiB", "96%" and "5,125" all read as numbers.
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

export function requireNumber(block, text, where) {
  const cell = parseCell(text);

  if (cell === null) {
    fail(block, `"${text}" in ${where} isn't a number`);
  }

  return cell;
}

// The scale's top: the `max` option, else the largest "/N", else the
// largest value.
export function scaleTop(options, cells) {
  if (options.max !== undefined) {
    return options.max;
  }

  return Math.max(...cells.map((cell) => cell.max ?? cell.value));
}

export function percentOf(value, top, digits = 1) {
  const share = top > 0 ? value / top : 0;

  return (Math.min(1, Math.max(0, share)) * 100).toFixed(digits);
}

// Fills "{name}" placeholders; unknown ones stay as written.
export function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (all, key) => values[key] ?? all);
}

// ---- Markup -----------------------------------------------------------

export function seriesClass(block, name) {
  const series = block.env?.palette?.[name];

  return series === undefined ? "" : `c-${series}`;
}

// The block's HTML without its table: the caption a reader sees under
// the table on GitHub.
export function captionOf(html) {
  return html.replace(TABLE_HTML, "").trim();
}

export function tableOf(html) {
  return html.match(TABLE_HTML)?.[0].trim() ?? "";
}

// Gives the first tag of `html` a class: `<p>` becomes `<p class="x">`.
export function withClass(html, tag, name) {
  return html.replace(`<${tag}>`, `<${tag} class="${name}">`);
}
