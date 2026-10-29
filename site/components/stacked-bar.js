// One stacked bar per row: each column between the label and the total
// is a segment, colored from the palette by its column name. A dash or
// an empty cell leaves that segment out.
//
//   <!-- lab:stacked-bar {"total": "Total", "max": 95, "unit": "GiB"} -->
//
// Options:
//   total     the column shown at the right of each bar (required)
//   max       the scale's top (required)
//   unit      appended to each segment's hover text
//   label     the column naming each bar (default: the first column)
//   minLabel  the smallest segment, in percent, that shows its name
//             inside the bar (default 10)
//
// Any paragraph after the table becomes the key under the chart.

import {
  captionOf,
  fail,
  percentOf,
  requireColumns,
  requireNumber,
  requireTable,
  seriesClass,
} from "./shared.js";

// ---- Constants --------------------------------------------------------

const EMPTY = new Set(["", "-", "—", "–"]);

const DEFAULT_MIN_LABEL = 10;

// ---- Chart ------------------------------------------------------------

function splitTotal(text) {
  const match = text.match(/^(\S+)(.*)$/);

  return { head: match[1], tail: match[2] };
}

export default function stackedBar(block) {
  const table = requireTable(block);
  const { options } = block;

  for (const option of ["total", "max"]) {
    if (options[option] === undefined) {
      fail(block, `needs a "${option}" option`);
    }
  }

  const label = options.label ?? table.columns[0];
  const unit = options.unit ? ` ${options.unit}` : "";
  const minLabel = options.minLabel ?? DEFAULT_MIN_LABEL;

  requireColumns(block, [label, options.total]);

  const parts = table.columns.filter((column) => {
    return column !== label && column !== options.total;
  });

  return {
    key: captionOf(block.html),
    rows: table.rows.map((row) => {
      const segments = parts
        .filter((column) => !EMPTY.has(row[column]))
        .map((column) => {
          const where = `"${row[label]}", "${column}"`;
          const value = requireNumber(block, row[column], where).value;
          const percent = percentOf(value, options.max, 2);

          return {
            series: seriesClass(block, column),
            percent,
            hover: `${column}: ${row[column]}${unit}`,
            text: Number(percent) >= minLabel
              ? `${column} ${row[column]}`
              : "",
          };
        });

      return {
        name: row[label],
        segments,
        ...splitTotal(row[options.total]),
      };
    }),
  };
}
