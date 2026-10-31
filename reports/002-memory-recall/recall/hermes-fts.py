#!/usr/bin/env python3
"""Cells A1 and A2: Hermes Agent's own session_search over the corpus.

Runs inside the Hermes container with the image's Python, so the
search is Hermes's code path, not a reimplementation:

    HERMES_HOME=/opt/data /opt/hermes/.venv/bin/python hermes-fts.py \
        --corpus /work/corpus/seed-1 --out /work/results/seed-1

Builds a fresh state.db from sessions.json, one past session per
note, then asks session_search for every query two ways:

    A0  the fact's own sentence, a validity control
    A1  the query as typed
    A2  its content words joined with OR, as the tool's own no-match
        message advises

Each result line records the session ids in the order returned.

Licence: AGPL-3.0-or-later.
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import control_queries, load_json  # noqa: E402
from words import STOPWORDS, WORD_RE  # noqa: E402

LIMIT = 10
SOURCE = "cli"
MODEL = "gemma4:31b-128k"
SECONDS_BETWEEN_TURNS = 90
END_REASON = "exit"

CELLS = {
    "A0": "exact fact text, control",
    "A1": "as typed",
    "A2": "content words OR",
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def hermes_home():
    return Path(os.environ["HERMES_HOME"])


def reset_state_db(home):
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = home / f"state.db{suffix}"

        if path.exists():
            path.unlink()


def note_timestamp(note, index):
    day = dt.date.fromisoformat(note["date"])
    start = dt.datetime(day.year, day.month, day.day, 19, 0,
                        tzinfo=dt.timezone.utc)
    return (start + dt.timedelta(seconds=index * SECONDS_BETWEEN_TURNS)
            ).timestamp()


def build_sessions(home, notes):
    from hermes_state import SessionDB

    db = SessionDB(db_path=home / "state.db")
    turns = 0

    for note in notes:
        db.create_session(note["id"], SOURCE, model=MODEL)
        index = 0

        for paragraph, ack in zip(note["paragraphs"], note["acks"]):
            db.append_message(note["id"], "user", paragraph,
                              timestamp=note_timestamp(note, index))
            db.append_message(note["id"], "assistant", ack,
                              timestamp=note_timestamp(note, index + 1))
            index += 2
            turns += 1

        db.end_session(note["id"], END_REASON)

    db.close()
    return turns


def or_query(text):
    words = WORD_RE.findall(text.lower())
    kept = [w for w in words if len(w) >= 3 and w not in STOPWORDS]
    return " OR ".join(dict.fromkeys(kept))


def search(query_text):
    from tools.session_search_tool import session_search

    started = time.perf_counter()
    raw = session_search(query=query_text, limit=LIMIT)
    elapsed_ms = (time.perf_counter() - started) * 1000
    payload = json.loads(raw)

    ranked = [hit["session_id"] for hit in payload.get("results", [])]
    return ranked, payload, elapsed_ms


def run_cell(cell, queries, out):
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{cell}.jsonl"

    with path.open("w", encoding="utf-8") as handle:
        for query in queries:
            sent = query["text"] if cell == "A1" else or_query(query["text"])
            ranked, payload, elapsed_ms = search(sent)

            handle.write(json.dumps({
                "cell": cell,
                "qid": query["qid"],
                "note_id": query["note_id"],
                "text": query["text"],
                "sent": sent,
                "ranked": ranked,
                "sessions_searched": payload.get("sessions_searched", 0),
                "elapsed_ms": round(elapsed_ms, 1),
            }) + "\n")

    return path


def main():
    args = parse_args()
    home = hermes_home()

    notes = load_json(args.corpus / "sessions.json")
    queries = load_json(args.corpus / "queries.json")

    reset_state_db(home)
    turns = build_sessions(home, notes)
    print(f"built {len(notes)} sessions, {turns} turns in {home}/state.db")

    controls = control_queries(args.corpus)

    for cell in CELLS:
        chosen = controls if cell == "A0" else queries
        path = run_cell(cell, chosen, args.out)
        print(f"{cell} ({CELLS[cell]}): {len(chosen)} queries -> {path}")


if __name__ == "__main__":
    main()
