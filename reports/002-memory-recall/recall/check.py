#!/usr/bin/env python3
"""Check that no held-out query shares a content word with its gold fact,
with any filler sentence, or (given a corpus) with its whole gold note.

Usage:
    check.py                      facts and filler only
    check.py corpus/seed-1 ...    also each generated corpus

Words are compared as crude stems, so "leak" also blocks "leaking".
Exit status 1 when any collision is found. Prints each collision.

Licence: AGPL-3.0-or-later.
"""

import json
import sys
from pathlib import Path

from words import stems

HERE = Path(__file__).resolve().parent

FACTS_PATH = HERE / "facts.json"
FILLER_PATH = HERE / "filler.json"

FILLER_POOLS = ("openers", "weather", "meals", "routine", "media", "acks")


def load_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def filler_stems(filler):
    found = set()

    for pool in FILLER_POOLS:
        for sentence in filler[pool]:
            found |= stems(sentence)

    return found


def check_facts(facts, filler_words):
    problems = []

    for fact in facts:
        fact_words = stems(fact["text"])

        for index, query in enumerate(fact["queries"], start=1):
            query_words = stems(query)
            against_fact = query_words & fact_words
            against_filler = query_words & filler_words

            if against_fact:
                problems.append(
                    f"{fact['id']} q{index} shares {sorted(against_fact)} "
                    f"with its fact")

            if against_filler:
                problems.append(
                    f"{fact['id']} q{index} shares {sorted(against_filler)} "
                    f"with filler")

    return problems


def check_corpus(corpus, facts_by_id):
    problems = []
    notes = load_json(corpus / "sessions.json")
    queries = load_json(corpus / "queries.json")
    note_text = {note["id"]: " ".join(note["paragraphs"]) for note in notes}

    for query in queries:
        shared = stems(query["text"]) & stems(note_text[query["note_id"]])

        if shared:
            problems.append(
                f"{corpus.name} {query['qid']} shares {sorted(shared)} "
                f"with note {query['note_id']}")

    return problems


def main():
    facts = load_json(FACTS_PATH)["facts"]
    filler = load_json(FILLER_PATH)
    facts_by_id = {fact["id"]: fact for fact in facts}

    problems = check_facts(facts, filler_stems(filler))

    for arg in sys.argv[1:]:
        problems += check_corpus(Path(arg), facts_by_id)

    for problem in problems:
        print(problem)

    queries = sum(len(fact["queries"]) for fact in facts)
    print(f"{len(facts)} facts, {queries} queries, "
          f"{len(problems)} collisions")

    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
