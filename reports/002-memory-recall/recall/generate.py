#!/usr/bin/env python3
"""Build one seeded corpus of daily notes from facts.json and filler.json.

Usage:
    generate.py --seed 1 [--out corpus/seed-1]

Writes, under the output folder:
    notes/YYYY-MM-DD.md   one Markdown note per day, OpenClaw's format
    sessions.json         the same notes as user turns, Hermes's shape
    queries.json          every held-out query with its gold note id
    manifest.json         seed, counts, sizes and file digests

The same 120 facts land in every run; the seed decides which note
each fact lands in, the note dates, and the filler around it.

Licence: AGPL-3.0-or-later. Data it reads and writes: CC BY-SA 4.0.
"""

import argparse
import datetime as dt
import hashlib
import json
import random
import sys
from pathlib import Path

from words import stems

HERE = Path(__file__).resolve().parent

FACTS_PATH = HERE / "facts.json"
FILLER_PATH = HERE / "filler.json"

TODAY = dt.date(2026, 10, 30)
DATE_WINDOW_DAYS = 46

NOTES = 30
FACTS_PER_NOTE = 4
FILLER_PARAGRAPHS = (14, 17)
FILLER_BEFORE_FACT = (2, 3)
FILLER_AFTER_FACT = (1, 2)
FILLER_PARAGRAPH_SENTENCES = (5, 7)

MAX_SWAPS = 10000

FILLER_POOLS = ("meals", "routine", "media")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--notes", type=int, default=NOTES)
    parser.add_argument("--facts-per-note", type=int, default=FACTS_PER_NOTE)
    args = parser.parse_args()

    if args.out is None:
        args.out = HERE / "corpus" / f"seed-{args.seed}"

    return args


def load_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def pick_dates(rng, count):
    days = [TODAY - dt.timedelta(days=offset)
            for offset in range(1, DATE_WINDOW_DAYS + 1)]
    chosen = rng.sample(days, count)
    chosen.sort()
    return chosen


def query_collides(fact, others):
    """True when a query of `fact` shares a stem with another fact's text."""
    other_words = set()

    for other in others:
        other_words |= stems(other["text"])

    for query in fact["queries"]:
        if stems(query) & other_words:
            return True

    return False


def find_collision(groups):
    for group_index, group in enumerate(groups):
        for fact_index, fact in enumerate(group):
            others = [f for i, f in enumerate(group) if i != fact_index]

            if query_collides(fact, others):
                return group_index, fact_index

    return None


def separate_facts(rng, groups):
    """Swap facts between notes until no note holds a fact whose query
    shares a stem with another fact in the same note. The held-out
    queries must not get a free keyword hit from a neighbour."""
    for _ in range(MAX_SWAPS):
        collision = find_collision(groups)

        if collision is None:
            return groups

        group_index, fact_index = collision
        other_group = rng.randrange(len(groups))

        if other_group == group_index:
            continue

        other_index = rng.randrange(len(groups[other_group]))
        a = groups[group_index][fact_index]
        b = groups[other_group][other_index]
        groups[group_index][fact_index] = b
        groups[other_group][other_index] = a

    sys.exit("could not separate colliding facts; add more facts")


def assign_facts(rng, facts, notes, per_note):
    needed = notes * per_note

    if needed > len(facts):
        sys.exit(f"need {needed} facts, have {len(facts)}")

    order = list(facts)
    rng.shuffle(order)
    order = order[:needed]

    groups = [order[i * per_note:(i + 1) * per_note] for i in range(notes)]

    return separate_facts(rng, groups)


class FillerDraw:
    """Draw filler sentences without repeating one inside a note."""

    def __init__(self, rng, filler):
        self.rng = rng
        self.filler = filler
        self.used = set()

    def sentence(self, pool):
        candidates = [s for s in self.filler[pool] if s not in self.used]

        if not candidates:
            candidates = list(self.filler[pool])

        choice = self.rng.choice(candidates)
        self.used.add(choice)
        return choice

    def mixed(self, count):
        pools = [self.rng.choice(FILLER_POOLS) for _ in range(count)]
        return [self.sentence(pool) for pool in pools]


def fact_paragraph(rng, draw, fact):
    before = draw.mixed(rng.randint(*FILLER_BEFORE_FACT))
    after = draw.mixed(rng.randint(*FILLER_AFTER_FACT))
    return " ".join(before + [fact["text"]] + after)


def filler_paragraph(rng, draw):
    return " ".join(draw.mixed(rng.randint(*FILLER_PARAGRAPH_SENTENCES)))


def build_note(rng, filler, date, facts):
    draw = FillerDraw(rng, filler)

    opener = rng.choice(filler["openers"])
    weather = draw.sentence("weather")
    paragraphs = [f"{opener} {weather}"]

    body = [("fact", fact) for fact in facts]
    body += [("filler", None)
             for _ in range(rng.randint(*FILLER_PARAGRAPHS))]
    rng.shuffle(body)

    for kind, fact in body:
        if kind == "fact":
            paragraphs.append(fact_paragraph(rng, draw, fact))
            continue

        paragraphs.append(filler_paragraph(rng, draw))

    acks = [rng.choice(filler["acks"]) for _ in paragraphs]

    return {
        "id": f"note-{date.isoformat()}",
        "date": date.isoformat(),
        "fact_ids": [fact["id"] for fact in facts],
        "paragraphs": paragraphs,
        "acks": acks,
    }


def note_markdown(note):
    lines = [f"# {note['date']}", ""]

    for paragraph in note["paragraphs"]:
        lines.append(paragraph)
        lines.append("")

    return "\n".join(lines)


def build_queries(notes, facts_by_id):
    queries = []

    for note in notes:
        for fact_id in note["fact_ids"]:
            fact = facts_by_id[fact_id]

            for index, text in enumerate(fact["queries"], start=1):
                queries.append({
                    "qid": f"{fact_id}-q{index}",
                    "fact_id": fact_id,
                    "note_id": note["id"],
                    "text": text,
                })

    return queries


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def write_corpus(out, notes, queries, seed):
    notes_dir = out / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)

    digests = {}
    total_bytes = 0

    for note in notes:
        text = note_markdown(note).encode("utf-8")
        path = notes_dir / f"{note['date']}.md"
        path.write_bytes(text)
        digests[path.name] = sha256(text)
        total_bytes += len(text)

    sessions_path = out / "sessions.json"
    sessions_path.write_text(
        json.dumps(notes, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    queries_path = out / "queries.json"
    queries_path.write_text(
        json.dumps(queries, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manifest = {
        "seed": seed,
        "today": TODAY.isoformat(),
        "notes": len(notes),
        "facts": sum(len(note["fact_ids"]) for note in notes),
        "queries": len(queries),
        "note_bytes": total_bytes,
        "facts_sha256": sha256(FACTS_PATH.read_bytes()),
        "filler_sha256": sha256(FILLER_PATH.read_bytes()),
        "notes_sha256": digests,
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=1) + "\n", encoding="utf-8",
    )

    return manifest


def main():
    args = parse_args()

    facts = load_json(FACTS_PATH)["facts"]
    filler = load_json(FILLER_PATH)
    facts_by_id = {fact["id"]: fact for fact in facts}

    rng = random.Random(args.seed)
    dates = pick_dates(rng, args.notes)
    groups = assign_facts(rng, facts, args.notes, args.facts_per_note)

    notes = [build_note(rng, filler, date, group)
             for date, group in zip(dates, groups)]
    queries = build_queries(notes, facts_by_id)

    manifest = write_corpus(args.out, notes, queries, args.seed)

    print(f"seed {args.seed}: {manifest['notes']} notes, "
          f"{manifest['facts']} facts, {manifest['queries']} queries, "
          f"{manifest['note_bytes'] / 1024:.0f} KB -> {args.out}")


if __name__ == "__main__":
    main()
