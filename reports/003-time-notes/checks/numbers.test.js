// Every number the report and README quote in an arm row must match
// the scorer's summary.json. An arm row starts with the arm's letter;
// its numbers are read as one of four table shapes. Run from the
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

const SUMMARY = join(REPORT, "timenotes", "results", "summary",
  "summary.json");
const PAGES = ["index.md", "README.md"].map((name) => join(REPORT, name));

const ARM_ROW = /^\| (A|B|B2|E|D|E2) \|/;

const summary = JSON.parse(readFileSync(SUMMARY, "utf8"));

// One decimal of a percentage, rounding a half to the even neighbour
// the way Python's formatting does.
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

function whole(value) {
  const floor = Math.floor(value);
  const isHalf = Math.abs(value - floor - 0.5) < 1e-9;

  if (isHalf) {
    return String(floor % 2 === 0 ? floor : floor + 1);
  }

  return String(Math.round(value));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function armRows(markdown) {
  return markdown
    .split("\n")
    .filter((line) => ARM_ROW.test(line))
    .map((line) => line.split("|").map((part) => part.trim()).slice(1, -1));
}

// The main table: right, after, before, UNKNOWN, uncached tokens.
function expectedMain(arm) {
  const forced = summary.cells[arm].forced;
  const seeds = Object.values(forced.seeds);
  return [
    pct(forced.t_interval.mean),
    pct(mean(seeds.map((seed) => seed.right_after))),
    pct(mean(seeds.map((seed) => seed.right_before))),
    pct(forced.mean_unknown),
    whole(forced.mean_uncached),
  ];
}

// The chart under the deck: right, UNKNOWN, uncached tokens.
function expectedChart(arm) {
  const forced = summary.cells[arm].forced;
  return [
    pct(forced.t_interval.mean),
    pct(forced.mean_unknown),
    whole(forced.mean_uncached),
  ];
}

// The cost table: same, changed, floor. Only B2 changes its system
// prompt between turns; the other arms print n/a there.
function expectedCost(arm) {
  const cell = summary.cells[arm];
  const floor = cell.floor ? whole(cell.floor.uncached_mean) : "n/a";
  const changed = cell.forced.uncached_when_system_changed;
  return [
    whole(cell.forced.uncached_when_system_same),
    changed === null ? "n/a" : whole(changed),
    floor,
  ];
}

// The extras table: what-day right, says start time, callback.
function expectedExtras(arm) {
  const cell = summary.cells[arm];
  return [
    pct(cell.control.right),
    pct(cell.control.says_start_time),
    pct(cell.callbacks.mentions_item),
  ];
}

function startsWith(got, expected) {
  return expected.every((value, index) => got[index] === value);
}

function matchesAny(got, arm) {
  const shapes = [expectedMain, expectedChart, expectedCost,
    expectedExtras];
  return shapes.some((shape) => startsWith(got, shape(arm)));
}

for (const page of PAGES) {
  test(`arm rows in ${page.split("/").pop()} match summary.json`, () => {
    const rows = armRows(readFileSync(page, "utf8"));
    assert.ok(rows.length > 0, "no arm rows found");

    for (const row of rows) {
      const [arm, , ...numbers] = row;
      assert.ok(matchesAny(numbers, arm),
        `${arm}: ${numbers} matches no table shape; main is ` +
        `${expectedMain(arm)}, chart ${expectedChart(arm)}, cost ` +
        `${expectedCost(arm)}, extras ${expectedExtras(arm)}`);
    }
  });
}

test("the verdict in the report matches summary.json", () => {
  const index = readFileSync(join(REPORT, "index.md"), "utf8");
  assert.match(index, new RegExp(`\\*\\*${summary.verdict}\\*\\*`),
    `index.md should state the verdict **${summary.verdict}**`);
});
