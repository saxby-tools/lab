#!/usr/bin/env python3
"""Round 3, cells B3 to B5: the LanceDB plugin with fact extraction on.

Runs inside the Hermes container like hermes-lancedb.py, with the
same store, embedder and recall code. The difference is what is
stored: for each note, the plugin's own `extract()` turns the
session's messages into durable facts through Hermes's auxiliary
model chain (the main chat model, through Saxby), and those facts go
in as `fact` rows next to the turn rows.

    HERMES_HOME=/opt/data OLLAMA_API_KEY=ollama \
    PYTHONPATH=/opt/hermes:/opt/data/site-packages \
    /opt/hermes/.venv/bin/python hermes-lancedb-facts.py \
        --corpus /work/corpus/seed-1 --out /work/results/seed-1

Writes facts.json next to the results (what the model extracted per
note, so recall can be rerun without a model), then:

    B3  recall(kind="fact"), vector
    B4  recall(kind="fact"), hybrid
    B5  recall(kind="any"), vector

--notes N limits extraction to the first N notes for a smoke test.
--facts-from FILE skips extraction and loads a saved facts.json.
--redo-notes ID... with --facts-from, extracts those notes again,
rewrites the file, then runs the cells. Used once, on Oct. 31, 2026,
for seed 1's first note, whose extraction had timed out while six
stray containers from an earlier launch were sharing the model.

--shim runs the same thing as cells B6, B7 and B8 with two calls
patched: the plugin passes `response_format=` to Hermes's `call_llm`,
which this Hermes rejects, and reads `.content` off a reply that is
now a ChatCompletion. The shim maps the first into `extra_body`,
unwraps the second, and raises the plugin's 30-second timeout to 300
for a local 31B model. Prompt, parsing and storage stay the plugin's.
Found on Oct. 30, 2026; "as shipped" is the unpatched run.

Licence: AGPL-3.0-or-later.
"""

import argparse
import datetime as dt
import importlib.util
import json
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import load_json  # noqa: E402

LIMIT = 10
EMBED_BATCH = 32
MODEL = "bge-m3"
EMBED_URL = "http://host.docker.internal:11434/v1"
API_KEY_ENV = "OLLAMA_API_KEY"

CHAT_MODEL = "gemma4:31b-128k"
CHAT_URL = "http://host.docker.internal:11435/v1"

PLUGIN_DIR = "plugins/lancedb"
PACKAGE = "hermes_agent_memory"

CELLS = {
    "B3": ("fact", "vector"),
    "B4": ("fact", "hybrid"),
    "B5": ("any", "vector"),
}

SHIM_CELLS = {
    "B6": ("fact", "vector"),
    "B7": ("fact", "hybrid"),
    "B8": ("any", "vector"),
}

SHIM_TIMEOUT = 300

CONFIG = {
    "model": {
        "provider": "custom",
        "default": CHAT_MODEL,
        "base_url": CHAT_URL,
        "api_key": "saxby-benchmark",
        "context_length": 131072,
    },
    "memory": {"provider": "lancedb"},
    "plugins": {
        "lancedb": {
            "embedding": {
                "provider": "openai",
                "model": MODEL,
                "base_url": EMBED_URL,
                "api_key_env": API_KEY_ENV,
                "dimensions": None,
                "max_batch": EMBED_BATCH,
            },
            "retrieval": {
                "mode": "vector",
                "top_k": LIMIT,
                "search_kinds": ["fact"],
                "reranker": {"type": "rrf"},
            },
            "extraction": {"enabled": True, "min_turns": 3},
            "maintenance": {"enabled": False},
        },
    },
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--notes", type=int, default=None)
    parser.add_argument("--facts-from", type=Path, default=None)
    parser.add_argument("--redo-notes", nargs="+", default=[],
                        metavar="ID", help="with --facts-from: extract "
                        "these notes again and rewrite the file")
    parser.add_argument("--shim", action="store_true",
                        help="patch the two broken calls; cells B6 to B8")
    return parser.parse_args()


def hermes_home():
    return Path(os.environ["HERMES_HOME"])


def write_config(home):
    (home / "config.yaml").write_text(
        yaml.safe_dump(CONFIG, sort_keys=False), encoding="utf-8")


def import_plugin(home):
    root = home / PLUGIN_DIR
    spec = importlib.util.spec_from_file_location(
        PACKAGE, root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


def install_shim():
    """Make the plugin's extract() reach the model on this Hermes."""
    import agent.auxiliary_client as aux

    real_call = aux.call_llm

    class Reply:
        def __init__(self, content):
            self.content = content

    def patched(*args, response_format=None, timeout=None, **kwargs):
        extra = dict(kwargs.pop("extra_body", None) or {})

        if response_format is not None:
            extra["response_format"] = response_format

        response = real_call(*args, extra_body=extra or None,
                             timeout=SHIM_TIMEOUT, **kwargs)
        choices = getattr(response, "choices", None)

        if choices:
            return Reply(choices[0].message.content or "")

        return response

    aux.call_llm = patched


def reset_store(home):
    path = home / "lancedb"

    if path.exists():
        shutil.rmtree(path)


def open_store(home, plugin):
    config = plugin.src.config.load_config()
    embedder = plugin.src.embeddings.embedder_from_config(config["embedding"])

    # On a Docker bind mount a just-removed table dir can still be
    # listed for a moment, and create_table then says it exists; one
    # more reset and retry has been enough.
    for attempt in range(2):
        store = plugin.src.store.LanceDBStore(
            home, embedder, maintenance_enabled=False)

        try:
            store.open()
            return store
        except ValueError:
            if attempt:
                raise

            time.sleep(2)
            reset_store(home)

    return store


def note_time(note, index):
    day = dt.date.fromisoformat(note["date"])
    return dt.datetime(day.year, day.month, day.day, 19, index % 60,
                       tzinfo=dt.timezone.utc)


def session_messages(note):
    messages = []

    for paragraph, ack in zip(note["paragraphs"], note["acks"]):
        messages.append({"role": "user", "content": paragraph})
        messages.append({"role": "assistant", "content": ack})

    return messages


def extract_note(plugin, note):
    """The plugin's extract() over the session, timed, errors kept."""
    context = {
        "session_id": note["id"],
        "platform": "cli",
        "agent_identity": "",
        "agent_workspace": "",
        "user_id": "",
    }
    started = time.perf_counter()
    error = ""

    try:
        facts = plugin.src.extraction.extract(session_messages(note), context)
    except Exception:
        facts = []
        error = traceback.format_exc()

    return {
        "note_id": note["id"],
        "facts": facts,
        "count": len(facts),
        "elapsed_s": round(time.perf_counter() - started, 1),
        "error": error,
    }


def redo_notes(plugin, notes, extracted, ids, path):
    """Extract the named notes again and save the file in place."""
    by_id = {note["id"]: note for note in notes}
    redone = []

    for entry in extracted:
        if entry["note_id"] not in ids:
            redone.append(entry)
            continue

        entry = extract_note(plugin, by_id[entry["note_id"]])
        redone.append(entry)
        print(f"{entry['note_id']}: redone, {entry['count']} facts in "
              f"{entry['elapsed_s']} s"
              + ("  ERROR" if entry["error"] else ""), flush=True)

    path.write_text(json.dumps(redone, indent=1, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    return redone


def turn_row(plugin, note, index, role, content):
    store = plugin.src.store
    return {
        "id": store.stable_turn_id(note["id"], index, role, content),
        "kind": "turn",
        "content": content,
        "abstract": "",
        "category": "",
        "tags": [],
        "provenance_turn_ids": [],
        "session_id": note["id"],
        "turn_index": index,
        "role": role,
        "user_id": "",
        "agent_identity": "",
        "agent_workspace": "",
        "platform": "cli",
        "source": "sync_turn",
        "created_at": note_time(note, index),
        "content_hash": store.content_hash(content, workspace="", kind="turn"),
    }


def fact_row(plugin, note, fact):
    """What the provider's build_fact_row makes, with the note as session."""
    store = plugin.src.store
    content = fact["content"]
    return {
        "id": store.make_id("fact"),
        "kind": "fact",
        "content": content,
        "abstract": fact.get("abstract", ""),
        "category": fact.get("category", "general") or "general",
        "tags": fact.get("tags", []),
        "provenance_turn_ids": [],
        "session_id": note["id"],
        "turn_index": 0,
        "role": "",
        "user_id": "",
        "agent_identity": "",
        "agent_workspace": "",
        "platform": "cli",
        "source": "session_end",
        "created_at": note_time(note, 59),
        "content_hash": store.content_hash(content, workspace="", kind="fact"),
    }


def load_rows(plugin, store, notes, extracted):
    rows = []
    facts_by_note = {entry["note_id"]: entry["facts"] for entry in extracted}

    for note in notes:
        index = 0

        for paragraph, ack in zip(note["paragraphs"], note["acks"]):
            rows.append(turn_row(plugin, note, index, "user", paragraph))
            rows.append(turn_row(plugin, note, index + 1, "assistant", ack))
            index += 2

        for fact in facts_by_note.get(note["id"], []):
            rows.append(fact_row(plugin, note, fact))

    for start in range(0, len(rows), EMBED_BATCH):
        store.add_rows(rows[start:start + EMBED_BATCH])

    return len(rows)


def recall(plugin, store, text, kind, mode):
    started = time.perf_counter()
    rows = plugin.src.retrieval.recall(
        store, text, mode=mode, kind=kind, limit=LIMIT, reranker_type="rrf")
    elapsed_ms = (time.perf_counter() - started) * 1000
    return ([row["session_id"] for row in rows],
            [row["kind"] for row in rows], elapsed_ms)


def run_cell(cell, plugin, store, queries, out, kind_mode):
    kind, mode = kind_mode
    path = out / f"{cell}.jsonl"

    with path.open("w", encoding="utf-8") as handle:
        for query in queries:
            ranked, kinds, elapsed_ms = recall(plugin, store, query["text"],
                                               kind, mode)
            handle.write(json.dumps({
                "cell": cell,
                "qid": query["qid"],
                "note_id": query["note_id"],
                "text": query["text"],
                "sent": query["text"],
                "ranked": ranked,
                "kinds": kinds,
                "elapsed_ms": round(elapsed_ms, 1),
            }) + "\n")
            handle.flush()

    return path


def main():
    args = parse_args()
    home = hermes_home()
    notes = load_json(args.corpus / "sessions.json")
    queries = load_json(args.corpus / "queries.json")

    if args.notes:
        notes = notes[:args.notes]
        queries = [q for q in queries
                   if q["note_id"] in {n["id"] for n in notes}]

    write_config(home)
    plugin = import_plugin(home)
    args.out.mkdir(parents=True, exist_ok=True)
    cells = CELLS
    facts_name = "facts.json"

    if args.shim:
        install_shim()
        cells = SHIM_CELLS
        facts_name = "facts-shim.json"

    if args.facts_from:
        extracted = load_json(args.facts_from)

        if args.redo_notes:
            extracted = redo_notes(plugin, notes, extracted,
                                   args.redo_notes, args.facts_from)
    else:
        extracted = []

        for note in notes:
            entry = extract_note(plugin, note)
            extracted.append(entry)
            print(f"{note['id']}: {entry['count']} facts in "
                  f"{entry['elapsed_s']} s"
                  + ("  ERROR" if entry["error"] else ""), flush=True)

        (args.out / facts_name).write_text(
            json.dumps(extracted, indent=1, ensure_ascii=False) + "\n",
            encoding="utf-8")

    empty = sum(1 for entry in extracted if entry["count"] == 0)
    total = sum(entry["count"] for entry in extracted)
    print(f"extracted {total} facts; {empty} of {len(extracted)} notes "
          f"got none", flush=True)

    reset_store(home)
    store = open_store(home, plugin)
    rows = load_rows(plugin, store, notes, extracted)
    print(f"stored {rows} rows", flush=True)

    for cell in cells:
        path = run_cell(cell, plugin, store, queries, args.out, cells[cell])
        print(f"{cell} {cells[cell]}: {len(queries)} queries -> {path}",
              flush=True)


if __name__ == "__main__":
    main()
