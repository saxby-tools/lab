#!/usr/bin/env python3
"""Score every results/seed-*/<cell>.jsonl and write the summary tables.

Usage:
    score.py [--results results] [--out results/summary]

A query succeeds at k when its gold note id is among the first k
items as the harness returned them. "Dedup" collapses repeated items
from one note before counting, so k then means k distinct notes.

Per cell: recall at 1, 5 and 10 per seed; the mean over seeds with a
95 percent t-interval (n = 3, t = 4.303); the pooled rate over every
query in every seed with a Wilson interval; and the queries missed at
5 in every seed.

Writes summary.json and summary.md next to the results.

Licence: AGPL-3.0-or-later.
"""

import argparse
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent

KS = (1, 5, 10)
PRIMARY_K = 5

T_95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571}
Z_95 = 1.96

CELL_LABELS = {
    "A0": "Hermes FTS5, exact fact text (control)",
    "B0": "Hermes LanceDB bge-m3, exact fact text (control)",
    "C0": "OpenClaw bge-m3 hybrid, exact fact text (control)",
    "A1": "Hermes FTS5, as typed",
    "A2": "Hermes FTS5, content words OR",
    "B1": "Hermes LanceDB bge-m3, vector",
    "B2": "Hermes LanceDB bge-m3, hybrid",
    "C1": "OpenClaw keyword only",
    "C2": "OpenClaw bge-m3 hybrid",
    "C3": "OpenClaw bge-m3 hybrid, no score cut (post hoc)",
    "C4": "OpenClaw bge-m3 hybrid, undated notes (post hoc)",
    "C4-control": "OpenClaw bge-m3 hybrid, undated, exact fact text (post hoc)",
}

VERDICT_GO = 0.90
VERDICT_FAIL = 0.70
VERDICT_CELL = "B2"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--results", type=Path, default=HERE / "results")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    if args.out is None:
        args.out = args.results / "summary"

    return args


def load_jsonl(path):
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def discover(results):
    """{cell: {seed: [rows]}} from results/seed-N/CELL.jsonl."""
    found = {}

    for seed_dir in sorted(results.glob("seed-*")):
        seed = int(seed_dir.name.split("-")[1])

        for path in sorted(seed_dir.glob("*.jsonl")):
            rows = load_jsonl(path)

            if not rows:
                continue

            found.setdefault(path.stem, {})[seed] = rows

    return found


def dedup(ranked):
    return list(dict.fromkeys(ranked))


def hit(row, k, distinct):
    ranked = dedup(row["ranked"]) if distinct else row["ranked"]
    return row["note_id"] in ranked[:k]


def rate(rows, k, distinct=False):
    if not rows:
        return 0.0

    return sum(hit(row, k, distinct) for row in rows) / len(rows)


def mean(values):
    return sum(values) / len(values)


def t_interval(values):
    n = len(values)
    m = mean(values)

    if n < 2:
        return m, m, m

    variance = sum((v - m) ** 2 for v in values) / (n - 1)
    half = T_95[n - 1] * math.sqrt(variance / n)
    return m, max(0.0, m - half), min(1.0, m + half)


def wilson(successes, total):
    if total == 0:
        return 0.0, 0.0, 0.0

    p = successes / total
    z2 = Z_95 ** 2
    centre = (p + z2 / (2 * total)) / (1 + z2 / total)
    half = Z_95 * math.sqrt(
        p * (1 - p) / total + z2 / (4 * total * total)
    ) / (1 + z2 / total)
    return p, max(0.0, centre - half), min(1.0, centre + half)


def user_rows_only(rows):
    """Post hoc, B cells: the same ranked lists with the assistant's
    acknowledgement rows removed, as if the plugin skipped them."""
    kept = []

    for row in rows:
        if "roles" not in row:
            return None

        ranked = [note for note, role in zip(row["ranked"], row["roles"])
                  if role == "user"]
        kept.append({**row, "ranked": ranked})

    return kept


def ack_share(rows, k):
    """B cells: the share of the first k rows that are acknowledgements."""
    total = 0
    acks = 0

    for row in rows:
        roles = row.get("roles")

        if roles is None:
            return None

        total += len(roles[:k])
        acks += sum(1 for role in roles[:k] if role == "assistant")

    return acks / total if total else None


def misses_everywhere(seeds, k):
    """Queries that missed at k in every seed, with where the gold
    note ranked in each seed (0 = not returned)."""
    by_qid = {}

    for seed, rows in sorted(seeds.items()):
        for row in rows:
            by_qid.setdefault(row["qid"], {})[seed] = row

    missed = []

    for qid, per_seed in sorted(by_qid.items()):
        if any(hit(row, k, False) for row in per_seed.values()):
            continue

        ranks = {}

        for seed, row in per_seed.items():
            ranked = row["ranked"]
            ranks[seed] = (ranked.index(row["note_id"]) + 1
                           if row["note_id"] in ranked else 0)

        first = next(iter(per_seed.values()))
        missed.append({"qid": qid, "text": first["text"], "rank": ranks})

    return missed


def score_cell(cell, seeds):
    per_seed = {}

    for seed, rows in sorted(seeds.items()):
        per_seed[seed] = {
            "queries": len(rows),
            **{f"recall@{k}": rate(rows, k) for k in KS},
            f"distinct@{PRIMARY_K}": rate(rows, PRIMARY_K, True),
            "median_ms": sorted(r["elapsed_ms"] for r in rows)[len(rows) // 2],
        }
        user_only = user_rows_only(rows)

        if user_only is not None:
            per_seed[seed][f"user_rows@{PRIMARY_K}"] = rate(user_only, PRIMARY_K)
            per_seed[seed][f"ack_share@{PRIMARY_K}"] = ack_share(rows, PRIMARY_K)

    primary = [per_seed[s][f"recall@{PRIMARY_K}"] for s in per_seed]
    m, lo, hi = t_interval(primary)

    pooled_rows = [row for rows in seeds.values() for row in rows]
    successes = sum(hit(row, PRIMARY_K, False) for row in pooled_rows)
    p, wlo, whi = wilson(successes, len(pooled_rows))

    return {
        "cell": cell,
        "label": CELL_LABELS.get(cell, cell),
        "seeds": per_seed,
        "mean": {f"recall@{k}": mean([per_seed[s][f"recall@{k}"]
                                    for s in per_seed]) for k in KS},
        "mean_distinct@5": mean([per_seed[s][f"distinct@{PRIMARY_K}"]
                                 for s in per_seed]),
        "mean_user_rows@5": mean([per_seed[s][f"user_rows@{PRIMARY_K}"]
                                  for s in per_seed])
        if all(f"user_rows@{PRIMARY_K}" in per_seed[s] for s in per_seed)
        else None,
        "mean_ack_share@5": mean([per_seed[s][f"ack_share@{PRIMARY_K}"]
                                  for s in per_seed])
        if all(f"ack_share@{PRIMARY_K}" in per_seed[s] for s in per_seed)
        else None,
        "t_interval@5": {"mean": m, "low": lo, "high": hi},
        "pooled@5": {"rate": p, "low": wlo, "high": whi,
                     "successes": successes, "queries": len(pooled_rows)},
        "missed_every_seed@5": misses_everywhere(seeds, PRIMARY_K),
    }


def verdict(summary):
    cell = summary.get(VERDICT_CELL)

    if cell is None:
        return "not run"

    value = cell["t_interval@5"]["mean"]

    if value >= VERDICT_GO:
        return "go"

    if value <= VERDICT_FAIL:
        return "fail"

    return "inconclusive"


def pct(value):
    return f"{value * 100:.1f}"


def markdown(summary, verdict_text):
    lines = ["# Recall summary", ""]
    lines.append("Mean over seeds, recall at k; 95 percent t-interval "
                 "on recall at 5; pooled Wilson interval at 5.")
    lines.append("")
    lines.append("| Cell | What | at 1 | at 5 | at 10 | Distinct at 5 "
                 "| t-interval at 5 | Pooled at 5 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")

    for cell in sorted(summary):
        s = summary[cell]
        t = s["t_interval@5"]
        p = s["pooled@5"]
        lines.append(
            f"| {cell} | {s['label']} | {pct(s['mean']['recall@1'])} "
            f"| {pct(s['mean']['recall@5'])} | {pct(s['mean']['recall@10'])} "
            f"| {pct(s['mean_distinct@5'])} "
            f"| {pct(t['low'])} to {pct(t['high'])} "
            f"| {pct(p['rate'])} ({pct(p['low'])} to {pct(p['high'])}, "
            f"n={p['queries']}) |")

    lines += ["", f"Verdict on {VERDICT_CELL} at the preregistered bar: "
              f"**{verdict_text}**.", ""]
    lines.append("## Post hoc, B cells: acknowledgement rows")
    lines.append("")
    lines.append("| Cell | Ack share of top 5 | Recall at 5, user rows only |")
    lines.append("| --- | --- | --- |")

    for cell in sorted(summary):
        s = summary[cell]

        if s["mean_ack_share@5"] is None:
            continue

        lines.append(f"| {cell} | {pct(s['mean_ack_share@5'])} "
                     f"| {pct(s['mean_user_rows@5'])} |")

    lines.append("")
    lines.append("## Per seed, recall at 5")
    lines.append("")
    seeds = sorted({seed for s in summary.values() for seed in s["seeds"]})
    lines.append("| Cell | " + " | ".join(f"Seed {s}" for s in seeds) + " |")
    lines.append("| --- | " + " | ".join("---" for _ in seeds) + " |")

    for cell in sorted(summary):
        cells = [pct(summary[cell]["seeds"][s]["recall@5"])
                 if s in summary[cell]["seeds"] else "" for s in seeds]
        lines.append(f"| {cell} | " + " | ".join(cells) + " |")

    lines += ["", "## Missed at 5 in every seed", ""]

    for cell in sorted(summary):
        missed = summary[cell]["missed_every_seed@5"]
        lines.append(f"### {cell}: {len(missed)} queries")
        lines.append("")

        for miss in missed:
            ranks = ", ".join(f"seed {s}: {r if r else 'absent'}"
                              for s, r in sorted(miss["rank"].items()))
            lines.append(f"- `{miss['qid']}` {miss['text']} ({ranks})")

        lines.append("")

    return "\n".join(lines)


def main():
    args = parse_args()
    found = discover(args.results)

    if not found:
        raise SystemExit(f"no results under {args.results}")

    summary = {cell: score_cell(cell, seeds) for cell, seeds in found.items()}
    verdict_text = verdict(summary)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "summary.json").write_text(
        json.dumps({"verdict": verdict_text, "cells": summary}, indent=1)
        + "\n", encoding="utf-8")
    (args.out / "summary.md").write_text(markdown(summary, verdict_text),
                                         encoding="utf-8")

    for cell in sorted(summary):
        s = summary[cell]
        print(f"{cell} {s['label']}: recall@5 {pct(s['mean']['recall@5'])} "
              f"(seeds {', '.join(pct(v['recall@5']) for v in s['seeds'].values())})")

    print(f"verdict ({VERDICT_CELL}): {verdict_text}")


if __name__ == "__main__":
    main()
