import assert from "node:assert/strict";
import { test } from "node:test";

import barChart, { parseCell } from "./bar-chart.js";
import { CommentBlockError } from "../plugins/comment-blocks.js";

// ---- Helpers ----------------------------------------------------------

function block(options, rows = [["Qwen", "23/24"], ["Gemma", "22/24"]]) {
  return {
    name: "bar-chart",
    line: 7,
    env: {},
    html: "<table></table>",
    options,
    table: {
      columns: ["Model", "Score"],
      rows: rows.map(([Model, Score]) => ({ Model, Score })),
    },
  };
}

// ---- Cells ------------------------------------------------------------

test("cells read as a number, an optional max and a unit", () => {
  assert.deepEqual(parseCell("23/24"), { value: 23, max: 24, unit: "" });
  assert.deepEqual(parseCell(" 17.2 GiB "), {
    value: 17.2,
    max: null,
    unit: "GiB",
  });
  assert.deepEqual(parseCell("5,125"), { value: 5125, max: null, unit: "" });
  assert.equal(parseCell("n/a"), null);
});

// ---- Chart ------------------------------------------------------------

test("bars scale to the largest /N and keep the cell's own text", () => {
  const view = barChart(block({ value: "Score", title: "Runs" }));

  assert.equal(view.title, "Runs");
  assert.deepEqual(view.rows, [
    { name: "Qwen", text: "23/24", percent: "95.8" },
    { name: "Gemma", text: "22/24", percent: "91.7" },
  ]);
});

test("a max option overrides the scale", () => {
  const view = barChart(block({ value: "Score", max: 46 }));

  assert.equal(view.rows[0].percent, "50.0");
});

test("without /N, bars scale to the largest value", () => {
  const rows = [["A", "17.2 GiB"], ["B", "34.4 GiB"]];
  const view = barChart(block({ value: "Score" }, rows));

  assert.deepEqual(view.rows.map((row) => row.percent), ["50.0", "100.0"]);
});

function assertFails(input, pattern) {
  assert.throws(() => barChart(input), (error) => {
    assert.ok(error instanceof CommentBlockError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("mistakes stop the build with the block's line", () => {
  assertFails(block({}), /line 7: bar-chart: needs a "value" option/);
  assertFails(block({ value: "Nope" }), /no column named "Nope"/);
  assertFails(block({ value: "Score", label: "Nope" }), /no column named/);
  assertFails(
    block({ value: "Score" }, [["Qwen", "n/a"]]),
    /"n\/a" in "Qwen" isn't a number/,
  );
  assertFails({ ...block({ value: "Score" }), table: null }, /needs a/);
});
