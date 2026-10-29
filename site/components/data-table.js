// A full table of numbers, set compact, with each row's first cell
// marked by its palette color.
//
//   <!-- lab:data-table -->
//
// Any paragraph after the table becomes the caption.

import { captionOf, requireTable, seriesClass } from "./shared.js";

export default function dataTable(block) {
  const table = requireTable(block);
  const [head, ...rest] = table.columns;

  return {
    columns: table.columns,
    caption: captionOf(block.html),
    rows: table.htmlRows.map((cells, i) => {
      const name = table.rows[i][head];

      return {
        name: cells[head],
        series: seriesClass(block, name),
        cells: rest.map((column) => cells[column]),
      };
    }),
  };
}
