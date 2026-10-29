// A finish order: ranked bars, each with a small detail under its name
// and its value split as "23" and "/24".
//
//   <!-- lab:race {"value": "Fully passing", "rank": "Rank",
//        "detail": "Lab"} -->
//
// Options:
//   value   the column holding each bar's number (required)
//   label   the column naming each bar (default: the first column
//           that isn't the rank)
//   rank    the column holding each place (required)
//   detail  a column shown small under each name
//   max     the scale's top (default: the largest "/N")
//
// Any paragraph after the table becomes the note under the chart.

import {
  captionOf,
  fail,
  percentOf,
  requireColumns,
  requireNumber,
  requireTable,
  scaleTop,
  seriesClass,
} from "./shared.js";

function splitValue(text) {
  const cut = text.search(/[\/\s]/);

  if (cut === -1) {
    return { head: text, tail: "" };
  }

  return { head: text.slice(0, cut), tail: text.slice(cut) };
}

export default function race(block) {
  const table = requireTable(block);
  const { options } = block;

  for (const option of ["value", "rank"]) {
    if (options[option] === undefined) {
      fail(block, `needs a "${option}" option naming a column`);
    }
  }

  const label = options.label ??
    table.columns.find((column) => column !== options.rank);
  const named = [label, options.value, options.rank];

  if (options.detail !== undefined) {
    named.push(options.detail);
  }

  requireColumns(block, named);

  const cells = table.rows.map((row) => {
    return requireNumber(block, row[options.value], `"${row[label]}"`);
  });

  const top = scaleTop(options, cells);

  return {
    note: captionOf(block.html),
    rows: table.rows.map((row, i) => {
      return {
        rank: row[options.rank],
        name: row[label],
        detail: options.detail === undefined ? "" : row[options.detail],
        series: seriesClass(block, row[label]),
        percent: percentOf(cells[i].value, top),
        ...splitValue(row[options.value]),
      };
    }),
  };
}
