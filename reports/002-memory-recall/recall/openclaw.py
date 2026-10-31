#!/usr/bin/env python3
"""Cells C1 and C2: OpenClaw's built-in memory_search over the corpus.

Runs on the host against the installed `openclaw` CLI, isolated from
any real agent by OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR, with no
gateway started:

    openclaw.py --corpus corpus/seed-1 --out results/seed-1 \
        --home /path/to/scratch --mode none

Modes: `none` (C1, keyword only) and `ollama` (C2, bge-m3 hybrid).
With --undated, the notes are copied in as entry-NN.md instead of
YYYY-MM-DD.md, which OpenClaw treats as evergreen, so its 30-day
recency decay does not apply: cells C4 and C4-control. Added after
the dated control came back at a fifth.

With --control, C0 runs after the mode's cell: each fact's own
sentence as the query, the validity check for the index. With
--no-threshold, C3 runs alone on the mode's existing index: the same
queries with `--min-score 0`, so the ranking is measured without
OpenClaw's default cut at 0.35. C3 was added after the first results
showed the default returning nothing for most paraphrases.
Each mode gets its own config, workspace and state dir under --home.
The notes are copied in as memory/YYYY-MM-DD.md, indexed once with
`openclaw memory index --force`, then every query runs through
`openclaw memory search --json`.

Licence: AGPL-3.0-or-later.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from corpus import control_queries, load_json  # noqa: E402

OPENCLAW = "openclaw"
AGENT = "main"
LIMIT = 10
MODEL = "bge-m3"
GATEWAY_PORT = 19989

CELLS = {
    "none": "C1",
    "ollama": "C2",
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--mode", choices=sorted(CELLS), required=True)
    parser.add_argument("--control", action="store_true",
                        help="also run C0: each fact's own sentence")
    parser.add_argument("--only-control", action="store_true",
                        help="run C0 alone on an existing index")
    parser.add_argument("--undated", action="store_true",
                        help="copy the notes in as entry-NN.md so OpenClaw "
                             "treats them as evergreen: cells C4 and C4-control")
    parser.add_argument("--no-threshold", action="store_true",
                        help="run C3 alone on an existing ollama index: "
                             "the same search with --min-score 0")
    return parser.parse_args()


def config_for(mode, workspace):
    search = {"provider": mode}

    if mode == "ollama":
        search["model"] = MODEL

    return {
        "agents": {
            "defaults": {
                "workspace": str(workspace),
                "bootstrapMaxChars": 2200,
            },
        },
        "gateway": {"port": GATEWAY_PORT, "mode": "local"},
        "plugins": {
            "entries": {
                "active-memory": {"enabled": False},
                "memory-wiki": {"enabled": False},
            },
        },
        "memory": {"search": search},
    }


def prepare_home(home, mode, corpus, undated=False):
    root = home / (mode + "-undated" if undated else mode)
    workspace = root / "workspace"
    state = root / "state"

    if root.exists():
        shutil.rmtree(root)

    (workspace / "memory").mkdir(parents=True)
    state.mkdir(parents=True)

    mapping = {}

    for index, note in enumerate(sorted((corpus / "notes").glob("*.md"))):
        name = f"entry-{index + 1:02d}.md" if undated else note.name
        shutil.copy(note, workspace / "memory" / name)
        mapping[Path(name).stem] = "note-" + note.stem

    (root / "mapping.json").write_text(json.dumps(mapping, indent=1) + "\n",
                                       encoding="utf-8")

    config_path = root / "openclaw.json"
    config_path.write_text(
        json.dumps(config_for(mode, workspace), indent=2) + "\n",
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["OPENCLAW_CONFIG_PATH"] = str(config_path)
    env["OPENCLAW_STATE_DIR"] = str(state)
    env["RECALL_MAPPING"] = str(root / "mapping.json")
    return env


def existing_home(home, mode):
    root = home / mode
    env = dict(os.environ)
    env["OPENCLAW_CONFIG_PATH"] = str(root / "openclaw.json")
    env["OPENCLAW_STATE_DIR"] = str(root / "state")
    return env


def run_cli(env, *args):
    command = [OPENCLAW, *args]
    completed = subprocess.run(
        command, env=env, capture_output=True, text=True, check=False,
    )

    if completed.returncode != 0:
        sys.exit(f"{' '.join(command)} failed:\n{completed.stdout}\n"
                 f"{completed.stderr}")

    return completed.stdout


def extract_json(stdout):
    """The CLI prints log lines around the JSON; take the outer object."""
    start = stdout.find("{")
    end = stdout.rfind("}")

    if start < 0 or end < 0:
        sys.exit(f"no JSON in CLI output:\n{stdout}")

    return json.loads(stdout[start:end + 1])


def build_index(env):
    run_cli(env, "memory", "index", "--agent", AGENT, "--force")
    status = extract_json(
        run_cli(env, "memory", "status", "--agent", AGENT, "--deep", "--json")
    )
    return status


def note_id_from_path(env, path):
    mapping_path = env.get("RECALL_MAPPING")

    if mapping_path and Path(mapping_path).exists():
        mapping = json.loads(Path(mapping_path).read_text(encoding="utf-8"))
        return mapping.get(Path(path).stem, "note-" + Path(path).stem)

    return "note-" + Path(path).stem


def search(env, text, min_score=None):
    extra = [] if min_score is None else ["--min-score", str(min_score)]
    started = time.perf_counter()
    stdout = run_cli(env, "memory", "search", "--agent", AGENT,
                     "--query", text, "--json", "--max-results", str(LIMIT),
                     *extra)
    elapsed_ms = (time.perf_counter() - started) * 1000
    payload = extract_json(stdout)

    hits = payload.get("results", [])
    ranked = [note_id_from_path(env, hit["path"]) for hit in hits]
    scores = [round(hit.get("score", 0), 4) for hit in hits]
    return ranked, scores, payload.get("stale", False), elapsed_ms


def run_cell(cell, env, queries, out, min_score=None):
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{cell}.jsonl"

    with path.open("w", encoding="utf-8") as handle:
        for query in queries:
            ranked, scores, stale, elapsed_ms = search(env, query["text"],
                                                       min_score)

            handle.write(json.dumps({
                "cell": cell,
                "qid": query["qid"],
                "note_id": query["note_id"],
                "text": query["text"],
                "sent": query["text"],
                "ranked": ranked,
                "scores": scores,
                "stale": stale,
                "elapsed_ms": round(elapsed_ms, 1),
            }) + "\n")
            handle.flush()

    return path


def main():
    args = parse_args()
    cell = CELLS[args.mode]
    queries = load_json(args.corpus / "queries.json")

    if args.no_threshold:
        suffix = "-undated" if args.undated else ""
        cell = "C5" if args.undated else "C3"
        env = existing_home(args.home, args.mode + suffix)
        path = run_cell(cell, env, queries, args.out, min_score=0)
        print(f"{cell} ({args.mode}{suffix}, min-score 0): "
              f"{len(queries)} -> {path}")
        return

    if args.only_control:
        env = existing_home(args.home, args.mode)
        controls = control_queries(args.corpus)
        path = run_cell("C0", env, controls, args.out)
        print(f"C0 ({args.mode}, exact fact text): {len(controls)} -> {path}")
        return

    if args.undated:
        cell = "C4"

    env = prepare_home(args.home, args.mode, args.corpus, args.undated)
    status = build_index(env)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{cell}-status.json").write_text(
        json.dumps(status, indent=1) + "\n", encoding="utf-8",
    )

    summary = status[0]["status"] if isinstance(status, list) else status
    print(f"{cell}: provider {summary.get('provider')}, "
          f"{summary.get('files')} files, {summary.get('chunks')} chunks")

    path = run_cell(cell, env, queries, args.out)
    print(f"{cell} ({args.mode}): {len(queries)} queries -> {path}")

    if not args.control:
        return

    controls = control_queries(args.corpus)
    control_cell = "C4-control" if args.undated else "C0"
    path = run_cell(control_cell, env, controls, args.out)
    print(f"{control_cell} ({args.mode}, exact fact text): "
          f"{len(controls)} -> {path}")


if __name__ == "__main__":
    main()
