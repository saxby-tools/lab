import assert from "node:assert/strict";
import { test } from "node:test";

import { CommentBlockError } from "markdown-it-comment-blocks";

import barChart from "./bar-chart.js";
import { parseCell } from "./shared.js";

// ---- Helpers ----------------------------------------------------------

function block(options, rows = [["Qwen", "23/24"], ["Gemma", "22/24"]]) {
  return {
    name: "bar-chart",
    line: 7,
    env: { palette: { Qwen: 1 } },
    html: "<table></table>\n<p>A caption.</p>\n",
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
  assert.equal(view.caption, "<p>A caption.</p>");
  assert.deepEqual(view.rows, [
    { name: "Qwen", text: "23/24", series: "c-1", percent: "95.8",
      over: false },
    { name: "Gemma", text: "22/24", series: "", percent: "91.7",
      over: false },
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

test("a marker sits on the same scale and flags bars past it", () => {
  const rows = [["A", "17.2 GiB"], ["B", "96.9 GiB"]];
  const options = { value: "Score", max: 110, marker: { at: 95, label: "x" } };
  const view = barChart(block(options, rows));

  assert.deepEqual(view.marker, { label: "x", percent: "86.4" });
  assert.deepEqual(view.rows.map((row) => row.over), [false, true]);
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
