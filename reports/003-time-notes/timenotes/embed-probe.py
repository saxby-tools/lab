#!/usr/bin/env python3
"""Probe: does a time note inside stored text move bge-m3 recall?

    python3 embed-probe.py --out results/embed-probe
    python3 embed-probe.py --out /tmp/probe --dry-run    # no model

Report 002's 120 invented facts, each with two held-out paraphrased
queries that share no words with it, are the memory rows. Each row
is embedded four ways: as is, and with a time note in front of it in
the three shapes report 003 tested, a daypart word, a clock time and
an ISO 8601 stamp. The queries are embedded once, plain, the way a
client sends them to a memory search. Recall at 1, 5 and 10 over the
120 rows says what the note costs; the mean cosine between rows says
how much a shared prefix pulls them together. Three seeds draw the
times. Nothing judges anything; the embedder is bge-m3 on Ollama.

Licence: AGPL-3.0-or-later.
"""

import argparse
import hashlib
import json
import math
import random
import statistics
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render  # noqa: E402

HERE = Path(__file__).resolve().parent
FACTS = HERE.parent.parent / "002-memory-recall" / "recall" / "facts.json"

URL = "http://127.0.0.1:11434"
MODEL = "bge-m3"
BATCH = 32
TIMEOUT_S = 120

ZONE = "America/New_York"
SPAN_START = "2026-09-14T07:00"
SPAN_DAYS = 42

CONDITIONS = ["plain", "word", "clock", "iso"]
LABELS = {
    "plain": "Fact text as is",
    "word": "Daypart word note in front",
    "clock": "Clock time note in front",
    "iso": "ISO 8601 note in front",
}
KS = [1, 5, 10]
SEEDS = [1, 2, 3]

DRY_DIM = 64


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--facts", type=Path, default=FACTS)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--url", default=URL)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--dry-run", action="store_true",
                        help="hash-based vectors, to test the pipeline")
    return parser.parse_args()


def load_facts(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["facts"]


def draw_times(facts, seed):
    """One simulated time per fact, over six weeks, from the seed."""
    rng = random.Random(seed)
    zone = ZoneInfo(ZONE)
    start = datetime.fromisoformat(SPAN_START).replace(tzinfo=zone)
    times = {}

    for fact in facts:
        minutes = rng.randrange(SPAN_DAYS * 24 * 60)
        times[fact["id"]] = start + timedelta(minutes=minutes)

    return times


def note_text(condition, moment):
    if condition == "word":
        return render.note(moment)

    if condition == "clock":
        return f"[It is {render.clock_text(moment)} on " \
               f"{render.date_text(moment)}.]"

    if condition == "iso":
        return f"[It is {render.iso_text(moment)}.]"

    return ""


def stored_text(condition, fact, moment):
    note = note_text(condition, moment)

    if not note:
        return fact["text"]

    return f"{note} {fact['text']}"


def dry_vector(text):
    """A deterministic pseudo-embedding: bag of hashed words."""
    vector = [0.0] * DRY_DIM

    for word in text.lower().split():
        digest = hashlib.sha256(word.encode("utf-8")).digest()
        vector[digest[0] % DRY_DIM] += 1.0

    return vector


def embed(args, texts):
    if args.dry_run:
        return [dry_vector(text) for text in texts]

    vectors = []

    for start in range(0, len(texts), BATCH):
        body = json.dumps({"model": args.model,
                           "input": texts[start:start + BATCH]}).encode()
        request = urllib.request.Request(
            f"{args.url}/api/embed", data=body,
            headers={"Content-Type": "application/json"})

        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            vectors.extend(json.load(response)["embeddings"])

    return vectors


def unit(vector):
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))


def rank_of_right(query_vector, row_vectors, right_index):
    scores = [cosine(query_vector, row) for row in row_vectors]
    right = scores[right_index]
    better = sum(1 for score in scores if score > right)
    best_wrong = max(score for i, score in enumerate(scores)
                     if i != right_index)
    return better + 1, right - best_wrong


def mean_pairwise_cosine(row_vectors):
    total = 0.0
    pairs = 0

    for i, a in enumerate(row_vectors):
        for b in row_vectors[i + 1:]:
            total += cosine(a, b)
            pairs += 1

    return total / pairs


def score_condition(query_vectors, row_vectors, facts):
    ranks = []
    margins = []

    for index, fact in enumerate(facts):
        for query_index in range(len(fact["queries"])):
            vector = query_vectors[(fact["id"], query_index)]
            rank, margin = rank_of_right(vector, row_vectors, index)
            ranks.append(rank)
            margins.append(margin)

    recall = {f"at_{k}": sum(1 for r in ranks if r <= k) / len(ranks)
              for k in KS}
    return {
        "n_queries": len(ranks),
        **recall,
        "margin_mean": statistics.mean(margins),
        "row_cosine_mean": mean_pairwise_cosine(row_vectors),
    }


def run(args, facts):
    query_texts = [(fact["id"], i, query) for fact in facts
                   for i, query in enumerate(fact["queries"])]
    query_vectors = dict(zip(
        [(fid, i) for fid, i, _ in query_texts],
        [unit(v) for v in embed(args, [q for _, _, q in query_texts])]))
    results = {condition: {} for condition in CONDITIONS}

    for seed in SEEDS:
        times = draw_times(facts, seed)

        for condition in CONDITIONS:
            texts = [stored_text(condition, fact, times[fact["id"]])
                     for fact in facts]
            rows = [unit(v) for v in embed(args, texts)]
            results[condition][seed] = score_condition(
                query_vectors, rows, facts)
            print(f"seed {seed} {condition:6} at5="
                  f"{results[condition][seed]['at_5'] * 100:.1f}",
                  flush=True)

    return results


def summarise(results):
    cells = {}

    for condition in CONDITIONS:
        seeds = results[condition]
        cells[condition] = {
            "label": LABELS[condition],
            "seeds": seeds,
            **{f"mean_at_{k}": statistics.mean(
                s[f"at_{k}"] for s in seeds.values()) for k in KS},
            "mean_margin": statistics.mean(
                s["margin_mean"] for s in seeds.values()),
            "mean_row_cosine": statistics.mean(
                s["row_cosine_mean"] for s in seeds.values()),
        }

    return cells


def write_markdown(cells, path, model):
    lines = [
        "# Embedding probe: a time note in the stored text", "",
        f"Recall at k over 120 rows, 240 paraphrased queries, percent, "
        f"mean of three seeds of drawn times; embedder {model}.", "",
        "| Condition | What | At 1 | At 5 | At 10 | Margin | "
        "Row cosine |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]

    for condition in CONDITIONS:
        cell = cells[condition]
        lines.append(
            f"| {condition} | {cell['label']} | "
            f"{cell['mean_at_1'] * 100:.1f} | {cell['mean_at_5'] * 100:.1f} | "
            f"{cell['mean_at_10'] * 100:.1f} | {cell['mean_margin']:.3f} | "
            f"{cell['mean_row_cosine']:.3f} |")

    lines += ["", "Margin is the mean cosine gap between the right row and "
              "the best wrong row; row cosine is the mean cosine between "
              "any two stored rows, higher meaning a shared prefix pulls "
              "them together."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main():
    args = parse_args()
    facts = load_facts(args.facts)
    results = run(args, facts)
    cells = summarise(results)
    args.out.mkdir(parents=True, exist_ok=True)
    model = "dry run" if args.dry_run else args.model
    (args.out / "summary.json").write_text(
        json.dumps({"model": model, "facts": str(args.facts.name),
                    "cells": cells}, indent=1) + "\n", encoding="utf-8")
    write_markdown(cells, args.out / "summary.md", model)

    for condition in CONDITIONS:
        cell = cells[condition]
        print(f"{condition:6} at1 {cell['mean_at_1'] * 100:.1f} "
              f"at5 {cell['mean_at_5'] * 100:.1f} "
              f"at10 {cell['mean_at_10'] * 100:.1f} "
              f"margin {cell['mean_margin']:.3f} "
              f"row cosine {cell['mean_row_cosine']:.3f}")


if __name__ == "__main__":
    main()
