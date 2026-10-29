// A grid of shaded cells: rows from the first column, one column per
// remaining table column. Each cell reads "3/3 (100%)": runs passing
// out of runs, then a share. The shade follows the runs.
//
//   <!-- lab:heatmap {"svgTitle": "Fully passing runs, by task"} -->
//
// Options:
//   svgTitle  the chart's accessible title
//   headers   {"Column": ["first line", "second line"]}; by default a
//             header splits at its last space
//   tooltip   hover text, with {column}, {row}, {count}, {of} and
//             {share}
//   id
//
// Any paragraph after the table becomes the chart's caption.

import { captionOf, fail, fillTemplate, requireTable } from "./shared.js";

// ---- Constants --------------------------------------------------------

const CELL = /^(\d+)\s*\/\s*(\d+)\s*\((\d+(?:\.\d+)?)%\)$/;

const GRID = {
  left: 142,
  top: 62,
  stepX: 94,
  stepY: 50,
  cellWidth: 90,
  cellHeight: 46,
  rowLabelX: 126,
};

const SHADES = 3;

const DEFAULT_TOOLTIP = "{column}, {row}: {count} of {of} runs, " +
  "{share}% of tests";

// ---- Cells ------------------------------------------------------------

function splitHeader(header, headers) {
  if (headers[header] !== undefined) {
    return headers[header];
  }

  const cut = header.lastIndexOf(" ");

  if (cut === -1) {
    return [header, ""];
  }

  return [header.slice(0, cut), header.slice(cut + 1)];
}

function readCell(block, text, where) {
  const match = text.match(CELL);

  if (!match) {
    fail(block, `"${text}" in ${where} isn't like "3/3 (100%)"`);
  }

  const [, count, of, share] = match;

  return { count: Number(count), of: Number(of), share };
}

// ---- Chart ------------------------------------------------------------

export default function heatmap(block) {
  const table = requireTable(block);
  const { options } = block;
  const [rowColumn, ...columns] = table.columns;
  const headers = options.headers ?? {};
  const tooltip = options.tooltip ?? DEFAULT_TOOLTIP;

  return {
    id: options.id ?? "heat",
    svgTitle: options.svgTitle ?? "",
    caption: captionOf(block.html),
    grid: GRID,
    width: GRID.left + GRID.stepX * (columns.length - 1) +
      GRID.cellWidth + 2,
    height: GRID.top + GRID.stepY * (table.rows.length - 1) +
      GRID.cellHeight + 2,
    columns: columns.map((column) => splitHeader(column, headers)),
    rows: table.rows.map((row) => {
      return {
        name: row[rowColumn],
        cells: columns.map((column) => {
          const where = `"${row[rowColumn]}", "${column}"`;
          const cell = readCell(block, row[column], where);
          const shade = Math.round((cell.count / cell.of) * SHADES);

          return {
            ...cell,
            shade,
            tooltip: fillTemplate(tooltip, {
              column,
              row: row[rowColumn],
              ...cell,
            }),
          };
        }),
      };
    }),
  };
}
