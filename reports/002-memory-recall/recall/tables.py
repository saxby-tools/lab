#!/usr/bin/env python3
"""Print the report's table rows from results/summary/summary.json.

Usage:
    tables.py chart     rows for the headline bar chart
    tables.py cells     rows for the full data table

Paste the output into index.md and README.md; checks/numbers.test.js
then verifies that every number on those pages still matches.

Licence: AGPL-3.0-or-later.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SUMMARY = HERE / "results" / "summary" / "summary.json"

CHART_ROWS = (
    ("B1", "Hermes LanceDB, vector"),
    ("B2", "Hermes LanceDB, hybrid"),
    ("A1", "Hermes FTS5, as typed"),
    ("A2", "Hermes FTS5, OR"),
    ("C1", "OpenClaw keyword"),
    ("C2", "OpenClaw hybrid"),
)

CELL_ORDER = ("A0", "A1", "A2", "B0", "B1", "B2", "C0", "C1", "C2", "C3",
              "C4", "C4-control", "C5", "B3", "B4", "B5", "B6", "B7", "B8")


def pct(value):
    return f"{value * 100:.1f}"


def chart(cells):
    for cell, name in CHART_ROWS:
        means = cells[cell]["mean"]
        print(f"| {name} | {pct(means['recall@1'])} | {pct(means['recall@5'])} "
              f"| {pct(means['recall@10'])} |")


def table(cells):
    for cell in CELL_ORDER:
        if cell not in cells:
            continue

        s = cells[cell]
        means = s["mean"]
        t = s["t_interval@5"]
        print(f"| {cell} | {s['label']} | {pct(means['recall@1'])} "
              f"| {pct(means['recall@5'])} | {pct(means['recall@10'])} "
              f"| {pct(t['low'])} to {pct(t['high'])} |")


def main():
    cells = json.loads(SUMMARY.read_text(encoding="utf-8"))["cells"]
    which = sys.argv[1] if len(sys.argv) > 1 else "cells"

    if which == "chart":
        chart(cells)
        return

    table(cells)


if __name__ == "__main__":
    main()
