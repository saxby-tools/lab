#!/usr/bin/env python3
"""Shuffle the personality replies into a blind rating packet.

Usage:
    packet.py --key /path/outside/the/repo/key.json [--seed 2]

Writes packet.md here: the replies in a seeded random order, labelled
R01 to R12, with no condition names. The key, which maps labels back
to conditions, goes to --key and must stay out of sight until the
ratings are in. Rate each reply 1 to 5 for warmth in the table.

Licence: AGPL-3.0-or-later.
"""

import argparse
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent

REPLIES = HERE / "replies" / "replies.json"
PACKET = HERE / "packet.md"
SHUFFLE_SEED = 2


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=SHUFFLE_SEED)
    return parser.parse_args()


def main():
    args = parse_args()
    records = json.loads(REPLIES.read_text(encoding="utf-8"))

    rng = random.Random(args.seed)
    order = list(records)
    rng.shuffle(order)

    lines = [
        "#  Blind rating packet: personality presets",
        "",
        "Every reply answers the same line from a cold start: "
        f"\"{records[0]['prompt']}\"",
        "",
        "Rate each reply from 1 (cold) to 5 (warm) in the table, without",
        "looking at the key. Warmth means how much it feels like a friend",
        "answering, not how useful or how long it is.",
        "",
        "| Label | Warmth 1 to 5 |",
        "| --- | --- |",
    ]
    key = []

    for index, record in enumerate(order, start=1):
        label = f"R{index:02d}"
        lines.append(f"| {label} | |")
        key.append({"label": label, "name": record["name"],
                    "condition": record["condition"]})

    lines.append("")

    for index, record in enumerate(order, start=1):
        lines.append(f"##  R{index:02d}")
        lines.append("")

        for reply_line in record["reply"].splitlines() or [""]:
            lines.append(f"> {reply_line}" if reply_line else ">")

        lines.append("")

    PACKET.write_text("\n".join(lines), encoding="utf-8")
    args.key.parent.mkdir(parents=True, exist_ok=True)
    args.key.write_text(json.dumps(key, indent=1) + "\n", encoding="utf-8")
    print(f"{len(order)} replies -> {PACKET}; key -> {args.key}")


if __name__ == "__main__":
    main()
