"""Shared corpus helpers for the arm scripts.

Licence: AGPL-3.0-or-later.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

FACTS_PATH = HERE / "facts.json"


def load_json(path):
    with Path(path).open(encoding="utf-8") as handle:
        return json.load(handle)


def control_queries(corpus):
    """One query per fact whose text IS the fact as written in the note.

    A validity check, not a hypothesis test: a harness that cannot find
    the exact sentence has a broken index, and its paraphrase numbers
    would mean nothing.
    """
    facts = {f["id"]: f for f in load_json(FACTS_PATH)["facts"]}
    notes = load_json(Path(corpus) / "sessions.json")
    queries = []

    for note in notes:
        for fact_id in note["fact_ids"]:
            queries.append({
                "qid": f"{fact_id}-exact",
                "fact_id": fact_id,
                "note_id": note["id"],
                "text": facts[fact_id]["text"],
            })

    return queries
