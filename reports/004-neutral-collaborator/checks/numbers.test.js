// Every number the report and README quote in a cell row must match
// the scorer's summary. A cell row starts with the cell's id, such as
// P1-NC; its numbers are read as one of several table shapes. Fixture
// rows (F14) and hypothesis rows (H4) are checked too. Run from the
// repository root: npm test.
//
// Licence: AGPL-3.0-or-later.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, "..");
const SUMMARY = join(REPORT, "collaborator", "results", "summary",
  "summary.json");
const PAGES = ["index.md", "README.md"].map((name) => join(REPORT, name));

const CELL_ROW = /^\| (P[01]-[NFB][CP]) \|/;
const FIXTURE_ROW = /^\| (F\d\d) \|/;
const HYPOTHESIS_ROW = /^\| (H[1-8]) \|/;

const VERDICT = "fail";
const VERDICT_CELL = "P1-NC";

const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));

// One decimal of a percentage, as Python's round() writes it: a half
// goes to the even neighbour.
function pct(value) {
  if (value === null || value === undefined) {
    return "–";
  }

  const scaled = value * 10;
  const floor = Math.floor(scaled);
  const isHalf = Math.abs(scaled - floor - 0.5) < 1e-9;
  let tenths = Math.round(scaled);

  if (isHalf) {
    tenths = floor % 2 === 0 ? floor : floor + 1;
  }

  return (tenths / 10).toFixed(1);
}

function rowsMatching(markdown, pattern) {
  return markdown
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.split("|").map((part) => part.trim()).slice(1, -1));
}

function cellOf(cell) {
  return summary.cells[cell];
}

function interval(rate) {
  const [low, high] = rate.wilson95;
  return `${pct(low)} to ${pct(high)}`;
}

// The main table: right, named the flaw, buried, contrarian, interval.
function expectedMain(cell) {
  const c = cellOf(cell);
  return [
    pct(c.accuracy.pct),
    pct(c.named_flaw.pct),
    pct(c.buried.pct),
    pct(c.contrarian.pct),
    interval(c.accuracy),
  ];
}

// The pushback table: held on flaws, held on sound plans, recovered,
// agree control.
function expectedPushback(cell) {
  const c = cellOf(cell);
  return [
    pct(c.by_twin.flawed.hold.pct),
    pct(c.by_twin.sound.hold.pct),
    pct(c.recovery.pct),
    pct(c.agree_control.pct),
  ];
}

// The chart under the deck: right, held on flaws, held on sound plans.
function expectedChart(cell) {
  const c = cellOf(cell);
  return [
    pct(c.accuracy.pct),
    pct(c.by_twin.flawed.hold.pct),
    pct(c.by_twin.sound.hold.pct),
  ];
}

// The seeds table: right, seed 1, seed 2, seed 3, spread.
function expectedSeeds(cell) {
  const c = cellOf(cell);
  return [
    pct(c.accuracy.pct),
    pct(c.accuracy.seeds["1"]),
    pct(c.accuracy.seeds["2"]),
    pct(c.accuracy.seeds["3"]),
    pct(c.accuracy.spread),
  ];
}

// The post hoc table: right over all 30, right over the 23 kept.
function expectedPostHoc(cell) {
  const c = cellOf(cell);
  return [pct(c.accuracy.pct), pct(c.post_hoc_accuracy.pct)];
}

// The agree control by twin: flawed, sound.
function expectedAgree(cell) {
  const c = cellOf(cell);
  return [pct(c.by_twin.flawed.agree.pct), pct(c.by_twin.sound.agree.pct)];
}

function startsWith(got, expected) {
  return expected.every((value, index) => got[index] === value);
}

function matchesAny(got, cell) {
  const shapes = [expectedMain, expectedPushback, expectedChart,
    expectedSeeds, expectedPostHoc, expectedAgree];
  return shapes.some((shape) => startsWith(got, shape(cell)));
}

for (const page of PAGES) {
  const name = page.split("/").pop();

  test(`cell rows in ${name} match the summary`, () => {
    const rows = rowsMatching(readFileSync(page, "utf8"), CELL_ROW);
    assert.ok(rows.length > 0, "no cell rows found");

    for (const row of rows) {
      const [cell, , ...numbers] = row;
      assert.ok(matchesAny(numbers, cell),
        `${cell}: ${numbers} matches no table shape; main is ` +
        `${expectedMain(cell)}, pushback ${expectedPushback(cell)}, ` +
        `chart ${expectedChart(cell)}, seeds ${expectedSeeds(cell)}, ` +
        `post hoc ${expectedPostHoc(cell)}, agree ${expectedAgree(cell)}`);
    }
  });
}

// A fixture row: the fixture, a description, then misses on the sound
// twin without the prefix and with it, each out of 18.
test("fixture rows in index.md match the per-fixture misses", () => {
  const rows = rowsMatching(readFileSync(join(REPORT, "index.md"), "utf8"),
    FIXTURE_ROW);
  assert.ok(rows.length > 0, "no fixture rows found");

  for (const [fixture, , p0, p1] of rows) {
    const f = summary.by_fixture[fixture];
    assert.equal(p0, `${f.P0_sound_misses} of ${f.P0_sound_n}`,
      `${fixture}: no prefix`);
    assert.equal(p1, `${f.P1_sound_misses} of ${f.P1_sound_n}`,
      `${fixture}: prefix`);
  }
});

// A hypothesis row: the id, its text, then "held" or "fell".
test("hypothesis rows in index.md match the summary", () => {
  const rows = rowsMatching(readFileSync(join(REPORT, "index.md"), "utf8"),
    HYPOTHESIS_ROW);
  assert.equal(rows.length, 8, "eight hypothesis rows expected");

  for (const [id, , outcome] of rows) {
    const held = summary.hypotheses[id];
    assert.equal(outcome, held ? "Held" : "Fell", `${id}`);
  }
});

test("the verdict in the report matches the summary", () => {
  const index = readFileSync(join(REPORT, "index.md"), "utf8");
  assert.equal(summary.verdict.band, VERDICT);
  assert.equal(summary.verdict.cell, VERDICT_CELL);
  assert.match(index, new RegExp(`\\*\\*${VERDICT}\\*\\*`),
    `index.md should state the verdict **${VERDICT}**`);
  assert.equal(summary.verdict.prefix_credited, false);
});
