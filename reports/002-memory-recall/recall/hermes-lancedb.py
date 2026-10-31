#!/usr/bin/env python3
"""Cells B1 and B2: the LanceDB memory plugin for Hermes, bge-m3 through
Ollama, over the corpus as raw turn rows.

Runs inside the Hermes container with the image's Python and the
plugin checked out under $HERMES_HOME/plugins/lancedb, so the store,
the embedder and the recall are the plugin's own code:

    HERMES_HOME=/opt/data OLLAMA_API_KEY=ollama \
    PYTHONPATH=/opt/hermes:/opt/data/site-packages \
    /opt/hermes/.venv/bin/python hermes-lancedb.py \
        --corpus /work/corpus/seed-1 --out /work/results/seed-1

Writes the plugin's config block into $HERMES_HOME/config.yaml, drops
any existing table, stores every user paragraph and every assistant
acknowledgement as a turn row the way sync_turn does, then recalls
each query in the plugin's vector mode (B1) and hybrid mode (B2).
B0 is the validity control: each fact's own sentence, vector mode.

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
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import control_queries, load_json  # noqa: E402

LIMIT = 10
EMBED_BATCH = 32
MODEL = "bge-m3"
EMBED_URL = "http://host.docker.internal:11434/v1"
API_KEY_ENV = "OLLAMA_API_KEY"

PLUGIN_DIR = "plugins/lancedb"
PACKAGE = "hermes_agent_memory"

CELLS = {
    "B0": "vector",
    "B1": "vector",
    "B2": "hybrid",
}

PLUGIN_CONFIG = {
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
                "mode": "hybrid",
                "top_k": LIMIT,
                "search_kinds": ["turn"],
                "reranker": {"type": "rrf"},
            },
            "extraction": {"enabled": False},
            "maintenance": {"enabled": False},
        },
    },
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def hermes_home():
    return Path(os.environ["HERMES_HOME"])


def write_config(home):
    path = home / "config.yaml"
    path.write_text(yaml.safe_dump(PLUGIN_CONFIG, sort_keys=False),
                    encoding="utf-8")


def import_plugin(home):
    """Load the plugin as the package its own __init__ expects."""
    root = home / PLUGIN_DIR
    spec = importlib.util.spec_from_file_location(
        PACKAGE, root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = module
    spec.loader.exec_module(module)
    return module


def reset_store(home):
    path = home / "lancedb"

    if path.exists():
        shutil.rmtree(path)


def open_store(home, plugin):
    config = plugin.src.config.load_config()
    embedder = plugin.src.embeddings.embedder_from_config(config["embedding"])
    store = plugin.src.store.LanceDBStore(
        home, embedder, maintenance_enabled=False,
    )
    store.open()
    return store, config


def note_time(note, index):
    day = dt.date.fromisoformat(note["date"])
    return dt.datetime(day.year, day.month, day.day, 19, index % 60,
                       tzinfo=dt.timezone.utc)


def turn_row(plugin, note, index, role, content):
    """The row sync_turn builds, minus the per-process message counter."""
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


def load_turns(plugin, store, notes):
    rows = []

    for note in notes:
        index = 0

        for paragraph, ack in zip(note["paragraphs"], note["acks"]):
            rows.append(turn_row(plugin, note, index, "user", paragraph))
            rows.append(turn_row(plugin, note, index + 1, "assistant", ack))
            index += 2

    for start in range(0, len(rows), EMBED_BATCH):
        store.add_rows(rows[start:start + EMBED_BATCH])

    return len(rows)


def recall(plugin, store, text, mode):
    started = time.perf_counter()
    rows = plugin.src.retrieval.recall(
        store, text, mode=mode, kind="turn", limit=LIMIT, reranker_type="rrf",
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    ranked = [row["session_id"] for row in rows]
    roles = [row["role"] for row in rows]
    return ranked, roles, elapsed_ms


def run_cell(cell, plugin, store, queries, out):
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{cell}.jsonl"
    mode = CELLS[cell]

    with path.open("w", encoding="utf-8") as handle:
        for query in queries:
            ranked, roles, elapsed_ms = recall(plugin, store, query["text"], mode)

            handle.write(json.dumps({
                "cell": cell,
                "qid": query["qid"],
                "note_id": query["note_id"],
                "text": query["text"],
                "sent": query["text"],
                "ranked": ranked,
                "roles": roles,
                "elapsed_ms": round(elapsed_ms, 1),
            }) + "\n")

    return path


def main():
    args = parse_args()
    home = hermes_home()

    notes = load_json(args.corpus / "sessions.json")
    queries = load_json(args.corpus / "queries.json")

    write_config(home)
    plugin = import_plugin(home)
    reset_store(home)
    store, config = open_store(home, plugin)

    print(f"embedder {config['embedding']['model']} at "
          f"{config['embedding']['base_url']}, dim {store.embedder.dim}")

    started = time.perf_counter()
    rows = load_turns(plugin, store, notes)
    print(f"stored {rows} turn rows from {len(notes)} notes in "
          f"{time.perf_counter() - started:.0f} s")

    controls = control_queries(args.corpus)

    for cell in CELLS:
        chosen = controls if cell == "B0" else queries
        path = run_cell(cell, plugin, store, chosen, args.out)
        print(f"{cell} ({CELLS[cell]}): {len(chosen)} queries -> {path}")


if __name__ == "__main__":
    main()
