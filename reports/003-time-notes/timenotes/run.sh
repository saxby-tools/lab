#!/bin/bash
# Rerun the time notes test from a clean checkout.
#
#   run.sh check            refuse any fixture whose times are close
#   run.sh seed N           all six arms for seed N, with the open
#                           resume, the what-day control and the
#                           repeat floor; about an hour on an M5 Max
#   run.sh score            summary tables under results/summary/
#
# Needs Ollama on 127.0.0.1:11434 with gemma4:31b-128k pulled, and
# Python 3.11 or later for zoneinfo. Nothing else should use the
# model while a seed runs, because the cost column reads the prompt
# cache. The runners overwrite nothing: a rerun of a seed skips rows
# that are already there, so delete results/seed-N to start over.
#
# Licence: AGPL-3.0-or-later.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

check() {
    python3 "$HERE/check.py" "$HERE/fixtures.json"
}

seed() {
    python3 "$HERE/run.py" --out "$HERE/results/seed-$1" --seed "$1" --extras
}

score() {
    python3 "$HERE/score.py" --results "$HERE/results"
}

case "${1:-}" in
    check) check ;;
    seed) seed "$2" ;;
    score) score ;;
    *) sed -n '2,15p' "$0"; exit 1 ;;
esac
