// Every recall number the report and README quote must match the
// scorer's summary.json. Run from the repository root: npm test.
//
// Licence: AGPL-3.0-or-later.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, "..");

const SUMMARY = join(REPORT, "recall", "results", "summary", "summary.json");
const PAGES = ["index.md", "README.md"].map((name) => join(REPORT, name));

const CELL_ROW =
  /^\| (A0|A1|A2|B0|B1|B2|B3|B4|B5|B6|B7|B8|C0|C1|C2|C3|C4|C4-control|C5) \|/;
const KS = [1, 5, 10];

const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));

// One decimal of a percentage, rounding a half to the even neighbour
// the way Python's formatting does, so 16.25 reads 16.2 on both sides.
function pct(value) {
  const scaled = value * 1000;
  const floor = Math.floor(scaled);
  const isHalf = Math.abs(scaled - floor - 0.5) < 1e-9;
  let tenths = Math.round(scaled);

  if (isHalf) {
    tenths = floor % 2 === 0 ? floor : floor + 1;
  }

  return (tenths / 10).toFixed(1);
}

function cellRows(markdown) {
  return markdown
    .split("\n")
    .filter((line) => CELL_ROW.test(line))
    .map((line) => line.split("|").map((part) => part.trim()).slice(1, -1));
}

function expected(cell) {
  const means = summary.cells[cell].mean;
  return KS.map((k) => pct(means[`recall@${k}`]));
}

for (const page of PAGES) {
  test(`recall numbers in ${page.split("/").pop()} match summary.json`, () => {
    const rows = cellRows(readFileSync(page, "utf8"));
    assert.ok(rows.length > 0, "no cell rows found");

    for (const row of rows) {
      const [cell, , ...numbers] = row;
      const want = expected(cell);
      const got = numbers.slice(0, KS.length);
      assert.deepEqual(got, want, `${cell}: ${got} should be ${want}`);
    }
  });
}

test("the verdict in the report matches summary.json", () => {
  const index = readFileSync(join(REPORT, "index.md"), "utf8");
  const verdict = summary.verdict;
  assert.match(index, new RegExp(`\\*\\*${verdict}\\*\\*`),
    `index.md should state the verdict **${verdict}**`);
});
