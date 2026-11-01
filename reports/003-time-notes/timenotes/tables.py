#!/usr/bin/env python3
"""Print the report's table rows from the summary.

    python3 tables.py arms      the main table, one row per arm
    python3 tables.py cost      uncached tokens, by whether the system
                                prompt changed, with the repeat floor
    python3 tables.py extras    what-day control and callbacks

Licence: AGPL-3.0-or-later.
"""

import json
import statistics
import sys
from pathlib import Path

SUMMARY = Path(__file__).parent / "results" / "summary" / "summary.json"

ARMS = ["A", "B", "B2", "E", "D", "E2"]


def pct(value):
    if value is None:
        return "n/a"

    return f"{value * 100:.1f}"


def num(value):
    if value is None:
        return "n/a"

    return f"{value:.0f}"


def arms(summary):
    for arm in ARMS:
        cell = summary["cells"][arm]
        forced = cell["forced"]
        seeds = list(forced["seeds"].values())
        after = statistics.mean([s["right_after"] for s in seeds])
        before = statistics.mean([s["right_before"] for s in seeds])
        t = forced["t_interval"]
        print(f"| {arm} | {cell['label']} | {pct(t['mean'])} | {pct(after)} | "
              f"{pct(before)} | {pct(forced['mean_unknown'])} | "
              f"{num(forced['mean_uncached'])} | {pct(t['low'])} to "
              f"{pct(t['high'])} |")


def cost(summary):
    for arm in ARMS:
        cell = summary["cells"][arm]
        forced = cell["forced"]
        floor = cell["floor"] or {}
        print(f"| {arm} | {cell['label']} | "
              f"{num(forced['uncached_when_system_same'])} | "
              f"{num(forced['uncached_when_system_changed'])} | "
              f"{num(floor.get('uncached_mean'))} |")


def extras(summary):
    for arm in ARMS:
        cell = summary["cells"][arm]
        control = cell["control"] or {}
        callbacks = cell["callbacks"] or {}
        print(f"| {arm} | {cell['label']} | {pct(control.get('right'))} | "
              f"{pct(control.get('says_start_time'))} | "
              f"{pct(callbacks.get('mentions_item'))} |")


def main():
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    which = sys.argv[1] if len(sys.argv) > 1 else "arms"
    {"arms": arms, "cost": cost, "extras": extras}[which](summary)


if __name__ == "__main__":
    main()
