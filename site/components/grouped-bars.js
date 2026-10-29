// A group of bars per row, one per remaining column, so each row's
// values sit side by side.
//
//   <!-- lab:grouped-bars {"title": "...", "flag": "A Chinese company"} -->
//
// Options:
//   title  a title above the chart
//   flag   a row to highlight
//   label  the column naming each group (default: the first column)
//   max    the scale's top (default: the largest "/N")

import {
  percentOf,
  requireColumns,
  requireNumber,
  requireTable,
  scaleTop,
  seriesClass,
} from "./shared.js";

function splitValue(text) {
  const cut = text.indexOf("/");

  if (cut === -1) {
    return { head: text, tail: "" };
  }

  return { head: text.slice(0, cut), tail: text.slice(cut) };
}

export default function groupedBars(block) {
  const table = requireTable(block);
  const { options } = block;
  const label = options.label ?? table.columns[0];

  requireColumns(block, [label]);

  const series = table.columns.filter((column) => column !== label);
  const cells = table.rows.flatMap((row) => {
    return series.map((column) => {
      const where = `"${row[label]}", "${column}"`;

      return requireNumber(block, row[column], where);
    });
  });
  const top = scaleTop(options, cells);

  return {
    title: options.title ?? null,
    rows: table.rows.map((row, i) => {
      return {
        name: row[label],
        flag: row[label] === options.flag,
        bars: series.map((column, k) => {
          const cell = cells[i * series.length + k];

          return {
            name: column,
            series: seriesClass(block, column),
            percent: percentOf(cell.value, top),
            ...splitValue(row[column]),
          };
        }),
      };
    }),
  };
}
