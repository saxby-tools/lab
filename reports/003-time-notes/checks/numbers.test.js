// Every number the report and README quote in an arm row must match
// the scorer's summary for that arm's round, and every probe row must
// match the embedding probe's summary. An arm row starts with the
// arm's name; its numbers are read as one of five table shapes. Run
// from the repository root: npm test.
//
// Licence: AGPL-3.0-or-later.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, "..");
const RESULTS = join(REPORT, "timenotes", "results");

const SUMMARIES = {
  1: join(RESULTS, "summary", "summary.json"),
  2: join(RESULTS, "round-2", "summary", "summary.json"),
  3: join(RESULTS, "round-3", "summary", "summary.json"),
};
const PROBE = join(RESULTS, "embed-probe", "summary.json");
const PAGES = ["index.md", "README.md"].map((name) => join(REPORT, name));

const ROUND_OF = {
  A: 1, B: 1, B2: 1, E: 1, D: 1, E2: 1,
  DC: 2, DCG: 2, DWG: 2, DIG: 2, EC: 2,
  ZS: 3, ZH: 3, ZN: 3, ZO: 3,
};
const ARM_ROW = /^\| (A|B|B2|E|D|E2|DC|DCG|DWG|DIG|EC|ZS|ZH|ZN|ZO) \|/;
const PROBE_ROW = /^\| (plain|word|clock|iso) \|/;

const VERDICTS = { 1: "inconclusive", 2: "go", 3: "fail" };

const summaries = {
  1: JSON.parse(readFileSync(SUMMARIES[1], "utf8")),
  2: JSON.parse(readFileSync(SUMMARIES[2], "utf8")),
  3: JSON.parse(readFileSync(SUMMARIES[3], "utf8")),
};
const probe = JSON.parse(readFileSync(PROBE, "utf8"));

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

function rowsMatching(markdown, pattern) {
  return markdown
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.split("|").map((part) => part.trim()).slice(1, -1));
}

function cellOf(arm) {
  return summaries[ROUND_OF[arm]].cells[arm];
}

// The main table: right, after, before, UNKNOWN, uncached tokens.
function expectedMain(arm) {
  const forced = cellOf(arm).forced;
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
  const forced = cellOf(arm).forced;
  return [
    pct(forced.t_interval.mean),
    pct(forced.mean_unknown),
    whole(forced.mean_uncached),
  ];
}

// The cost table: same, changed, floor. Only B2 changes its system
// prompt between turns; the other arms print n/a there.
function expectedCost(arm) {
  const cell = cellOf(arm);
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
  const cell = cellOf(arm);
  return [
    pct(cell.control.right),
    pct(cell.control.says_start_time),
    pct(cell.callbacks.mentions_item),
  ];
}

// Round 2's subsets: small hours, the rest, round 1's 30, week on,
// long gap. Round 1 arms have no subsets and never match this shape.
function expectedSplits(arm) {
  const splits = cellOf(arm).splits;

  if (!splits) {
    return null;
  }

  return [
    pct(splits.small_hours.right),
    pct(splits.rest.right),
    pct(splits.round_1_fixtures.right),
    pct(splits.week_on_after.right),
    pct(splits.long_gap.right),
  ];
}

// Round 3's zone table: travel, unknown, matters, does not matter,
// asks when it matters, pestering. Round 3 arms only.
function expectedZones(arm) {
  const zones = cellOf(arm).zone_splits;

  if (!zones) {
    return null;
  }

  return [
    pct(zones.travel.right),
    pct(zones.unknown.right),
    pct(zones.zone_matters.right),
    pct(zones.zone_does_not_matter.right),
    pct(zones.asks_when_it_matters.rate),
    pct(zones.pestering.rate),
  ];
}

// Round 3's travel rows by sender zone, in the summary's own order:
// Los Angeles, Tokyo, Berlin, Lisbon.
function expectedByZone(arm) {
  const zones = cellOf(arm).zone_splits;

  if (!zones) {
    return null;
  }

  return Object.values(zones.travel_by_zone).map((cell) => pct(cell.right));
}

function expectedProbe(condition) {
  const cell = probe.cells[condition];
  return [pct(cell.mean_at_1), pct(cell.mean_at_5), pct(cell.mean_at_10)];
}

function startsWith(got, expected) {
  return expected !== null
    && expected.every((value, index) => got[index] === value);
}

function matchesAny(got, arm) {
  const shapes = [expectedMain, expectedChart, expectedCost,
    expectedExtras, expectedSplits, expectedZones, expectedByZone];
  return shapes.some((shape) => startsWith(got, shape(arm)));
}

for (const page of PAGES) {
  test(`arm rows in ${page.split("/").pop()} match the summaries`, () => {
    const rows = rowsMatching(readFileSync(page, "utf8"), ARM_ROW);
    assert.ok(rows.length > 0, "no arm rows found");

    for (const row of rows) {
      const [arm, , ...numbers] = row;
      assert.ok(matchesAny(numbers, arm),
        `${arm}: ${numbers} matches no table shape; main is ` +
        `${expectedMain(arm)}, chart ${expectedChart(arm)}, cost ` +
        `${expectedCost(arm)}, extras ${expectedExtras(arm)}, splits ` +
        `${expectedSplits(arm)}, zones ${expectedZones(arm)}`);
    }
  });
}

test("probe rows in index.md match the probe summary", () => {
  const rows = rowsMatching(readFileSync(join(REPORT, "index.md"), "utf8"),
    PROBE_ROW);
  assert.ok(rows.length > 0, "no probe rows found");

  for (const row of rows) {
    const [condition, , ...numbers] = row;
    assert.ok(startsWith(numbers, expectedProbe(condition)),
      `${condition}: ${numbers} is not ${expectedProbe(condition)}`);
  }
});

test("the verdicts in the report match the summaries", () => {
  const index = readFileSync(join(REPORT, "index.md"), "utf8");

  for (const round of [1, 2, 3]) {
    const verdict = summaries[round].verdict;
    assert.equal(verdict, VERDICTS[round],
      `round ${round} summary should say ${VERDICTS[round]}`);
    assert.match(index, new RegExp(`\\*\\*${verdict}\\*\\*`),
      `index.md should state the verdict **${verdict}**`);
  }
});
