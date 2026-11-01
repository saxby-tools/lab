"""Build a blind packet of open-resume reply pairs for a human rater.

Each pair is one fixture's open resume on the "after" side, seed 1:
the reply from arm A (no time anywhere) and from arm E (note on the
latest message), shown as X and Y in an order drawn from a seeded
shuffle. The key, which side is which, is written OUTSIDE the repo
and stays there until the ratings are in.

    python3 survey.py --results results --seed 1 \
        --packet ../survey/packet.md --key /path/outside/repo/key.json

Licence: AGPL-3.0-or-later.
"""

import argparse
import json
import random
from pathlib import Path

ARM_LEFT = "A"
ARM_RIGHT = "E"
SIDE = "after"
VARIANT = "open"

QUESTION = (
    "Which reply reads as though the writer knows the time named in "
    "the conversation has passed? Write X, Y, both or neither.")


def load_rows(results, seed, arm):
    path = Path(results) / f"seed-{seed}" / f"{arm}.jsonl"
    rows = [json.loads(line) for line in path.open()]
    return {r["fixture"]: r for r in rows
            if r["variant"] == VARIANT and r["side"] == SIDE}


def load_fixtures(path):
    data = json.loads(Path(path).read_text())
    return data["open_resume"], {f["id"]: f for f in data["fixtures"]}


def build(resume_text, fixtures, left, right, shuffle_seed):
    rng = random.Random(shuffle_seed)
    pairs = []

    for fid in sorted(left):
        flipped = rng.random() < 0.5
        x_arm, y_arm = (ARM_RIGHT, ARM_LEFT) if flipped else (
            ARM_LEFT, ARM_RIGHT)
        x_row = right[fid] if flipped else left[fid]
        y_row = left[fid] if flipped else right[fid]
        pairs.append({
            "fixture": fid,
            "item": fixtures[fid]["item"],
            "turns": fixtures[fid]["turns"],
            "resume_at": x_row["resume_at"],
            "x": x_row["reply"].strip(),
            "y": y_row["reply"].strip(),
            "key": {"X": x_arm, "Y": y_arm},
        })

    return resume_text, pairs


def packet_text(resume_text, pairs):
    lines = [
        "#  Blind packet: open resumes, report 003",
        "",
        "Thirty pairs. Each shows a short conversation, then two",
        "replies to the same resume message, sent after the time the",
        "user named had passed. One reply comes from a setup that was",
        "told nothing about the time; the other from a setup whose",
        "latest message carried a time note. Which is which is drawn",
        "at random per pair and the key is not in this repo.",
        "",
        f"**Question, for every pair:** {QUESTION}",
        "",
        "Write the answers in `ratings.md` beside this file, one line",
        "per pair: `P01 X`, `P02 neither`, and so on.",
        "",
    ]

    for i, pair in enumerate(pairs, 1):
        lines += [f"##  P{i:02d}", ""]

        for turn in pair["turns"]:
            who = "User" if turn["role"] == "user" else "Assistant"
            stamp = f" ({turn['at']})" if "at" in turn else ""
            lines += [f"> **{who}{stamp}:** {turn['content']}", ">"]

        lines += [
            f"> **User ({pair['resume_at']}):** {resume_text}", "",
            f"**X:** {pair['x']}", "",
            f"**Y:** {pair['y']}", "",
        ]

    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results")
    ap.add_argument("--fixtures", default="fixtures.json")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--shuffle-seed", type=int, default=2026)
    ap.add_argument("--packet", required=True)
    ap.add_argument("--key", required=True)
    args = ap.parse_args()

    resume_text, fixtures = load_fixtures(args.fixtures)
    left = load_rows(args.results, args.seed, ARM_LEFT)
    right = load_rows(args.results, args.seed, ARM_RIGHT)
    resume_text, pairs = build(resume_text, fixtures, left, right,
                               args.shuffle_seed)

    Path(args.packet).write_text(packet_text(resume_text, pairs))
    key = {f"P{i:02d}": p["key"] for i, p in enumerate(pairs, 1)}
    Path(args.key).write_text(json.dumps(
        {"seed": args.seed, "shuffle_seed": args.shuffle_seed,
         "arms": {"X_or_Y": [ARM_LEFT, ARM_RIGHT]}, "key": key},
        indent=1))
    print(f"{len(pairs)} pairs -> {args.packet}; key -> {args.key}")


if __name__ == "__main__":
    main()
