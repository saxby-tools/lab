// Bars for one column of a table, colored per row from the palette.
//
//   <!-- lab:bar-chart {"value": "Security tests", "title": "..."} -->
//
// Options:
//   value    the column holding each bar's number (required)
//   label    the column naming each bar (default: the first column)
//   title    a title above the chart
//   max      the scale's top (default: the largest "/N", else the
//            largest value)
//   marker   {"at": 95, "label": "..."}: a dashed line across every
//            bar; values past it are marked as over
//   details  true to keep the whole table under the chart
//
// Any paragraph after the table becomes the chart's caption.

import {
  captionOf,
  fail,
  percentOf,
  requireColumns,
  requireNumber,
  requireTable,
  scaleTop,
  seriesClass,
  tableOf,
} from "./shared.js";

export default function barChart(block) {
  const table = requireTable(block);
  const { options } = block;

  if (options.value === undefined) {
    fail(block, 'needs a "value" option naming a column');
  }

  const label = options.label ?? table.columns[0];

  requireColumns(block, [label, options.value]);

  const cells = table.rows.map((row) => {
    return requireNumber(block, row[options.value], `"${row[label]}"`);
  });

  const top = scaleTop(options, cells);
  const marker = options.marker ?? null;

  return {
    title: options.title ?? null,
    caption: captionOf(block.html),
    tableHtml: options.details ? tableOf(block.html) : null,
    marker: marker === null ? null : {
      label: marker.label,
      percent: percentOf(marker.at, top),
    },
    rows: table.rows.map((row, i) => {
      return {
        name: row[label],
        text: row[options.value],
        series: seriesClass(block, row[label]),
        percent: percentOf(cells[i].value, top),
        over: marker !== null && cells[i].value > marker.at,
      };
    }),
  };
}
