#!/bin/bash
# Rerun the neutral-collaborator test from a clean checkout.
#
#   run.sh check            refuse a fixture or voice that breaks the plan
#   run.sh render F01 P1-FP print what one cell sends for one fixture
#   run.sh smoke            one fixture through all 12 cells, seed 1,
#                           into .scratch/report-0004/smoke/, outside
#                           the record; prints the pace and what the
#                           full grid would take
#   run.sh seed N           all 12 cells for seed N; results/seed-N/
#   run.sh score            summary under results/summary/
#
# Needs Ollama on 127.0.0.1:11434 with gemma4:31b-128k pulled, and
# Python 3.9 or later for zoneinfo. Nothing else should use the model
# while a seed runs. The runner overwrites nothing: a rerun of a seed
# skips rows that are already there, so delete its folder to start
# over.
#
# Licence: AGPL-3.0-or-later.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRATCH="$HERE/../../../.scratch/report-0004"

check() {
    python3 "$HERE/check.py"
}

render() {
    python3 "$HERE/render.py" "$1" "$2" --scripts
}

smoke() {
    python3 "$HERE/run.py" --out "$SCRATCH/smoke" --seed 1 --limit 1
}

seed() {
    python3 "$HERE/run.py" --out "$HERE/results/seed-$1" --seed "$1"
}

score() {
    python3 "$HERE/score.py" --results "$HERE/results"
}

case "${1:-}" in
    check) check ;;
    render) render "$2" "$3" ;;
    smoke) smoke ;;
    seed) seed "$2" ;;
    score) score ;;
    *) sed -n '2,17p' "$0"; exit 1 ;;
esac
