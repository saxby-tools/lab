#!/usr/bin/env python3
"""Personality arm: the same cold-start line under each preset.

Usage:
    run.py --work /path/to/work [--samples 2]

For every condition (five presets and a control) and every sample, a
fresh Hermes home is built from the template in this folder with
`display.personality` set, then the pinned Hermes image answers one
line through Saxby. The reply text is kept in replies/<name>.txt and
replies.json. Nothing is judged here; packet.py shuffles the replies
for a blind rating.

Licence: AGPL-3.0-or-later.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

IMAGE = "nousresearch/hermes-agent:v0.22.5"
PROMPT = "hey, I'm home. Long day."
CONDITIONS = ("none", "helpful", "teacher", "surfer", "hype", "kawaii")
SAMPLES = 2

TEMPLATE_CONFIG = HERE / "config.yaml"
TEMPLATE_SOUL = HERE / "SOUL.md"

REPLY_RE = re.compile(
    r"☤ Hermes\n(.*?)\n─+", re.DOTALL,
)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
DURATION_RE = re.compile(r"Duration:\s+(\S+)")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=SAMPLES)
    parser.add_argument("--out", type=Path, default=HERE / "replies")
    parser.add_argument("--reparse", action="store_true",
                        help="rebuild replies from the saved logs, no runs")
    return parser.parse_args()


def fresh_home(work, name, condition):
    home = work / "persona" / name

    if home.exists():
        shutil.rmtree(home)

    (home / "memories").mkdir(parents=True)

    config = TEMPLATE_CONFIG.read_text(encoding="utf-8")
    config = config.replace("personality: none", f"personality: {condition}")
    (home / "config.yaml").write_text(config, encoding="utf-8")
    shutil.copy(TEMPLATE_SOUL, home / "SOUL.md")
    return home


def run_hermes(home):
    command = [
        "docker", "run", "--init", "--rm",
        "-e", f"HERMES_UID={os.getuid()}", "-e", f"HERMES_GID={os.getgid()}",
        "-v", f"{home}:/opt/data",
        IMAGE, "hermes", "chat", "-q", PROMPT,
    ]
    started = time.perf_counter()
    completed = subprocess.run(command, capture_output=True, text=True,
                               check=False)
    elapsed = time.perf_counter() - started
    output = ANSI_RE.sub("", completed.stdout + completed.stderr)
    return output, elapsed, completed.returncode


def extract_reply(output):
    match = REPLY_RE.search(output)

    if match is None:
        return ""

    return match.group(1).strip()


def record(args, name, condition, sample, output, elapsed, code):
    reply = extract_reply(output)
    (args.out / f"{name}.txt").write_text(reply + "\n", encoding="utf-8")
    duration = DURATION_RE.search(output)
    print(f"{name}: {len(reply)} chars in {elapsed:.0f} s"
          + ("" if reply else "  (no reply parsed)"))
    return {
        "name": name,
        "condition": condition,
        "sample": sample,
        "prompt": PROMPT,
        "reply": reply,
        "chars": len(reply),
        "hermes_duration": duration.group(1) if duration else "",
        "wall_s": round(elapsed, 1),
        "exit_code": code,
    }


def reparse(args):
    old = json.loads((args.out / "replies.json").read_text(encoding="utf-8"))
    records = []

    for previous in old:
        output = (args.out / f"{previous['name']}.log").read_text(
            encoding="utf-8")
        records.append(record(args, previous["name"], previous["condition"],
                              previous["sample"], output, previous["wall_s"],
                              previous["exit_code"]))

    return records


def main():
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    if args.reparse:
        records = reparse(args)
        (args.out / "replies.json").write_text(
            json.dumps(records, indent=1, ensure_ascii=False) + "\n",
            encoding="utf-8")
        return

    records = []

    for condition in CONDITIONS:
        for sample in range(1, args.samples + 1):
            name = f"{condition}-{sample}"
            home = fresh_home(args.work, name, condition)
            output, elapsed, code = run_hermes(home)
            (args.out / f"{name}.log").write_text(output, encoding="utf-8")
            records.append(record(args, name, condition, sample, output,
                                  elapsed, code))


    (args.out / "replies.json").write_text(
        json.dumps(records, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8")


if __name__ == "__main__":
    main()
