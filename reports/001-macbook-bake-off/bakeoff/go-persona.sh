#!/bin/bash
#
# Bake-off round 2, persona-swap test: 3 tasks x 4 requesters x 10 runs
# for each model. Both models run side by side.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"

run_model() {
  local model="$1"
  local log="$2"

  echo "start $model $(date)" >> "$log"

  deno run -A --no-config --no-lock \
    "$ROOT/round2/run-persona.ts" "$model" >> "$log" 2>&1

  echo "model done $model $(date)" >> "$log"
}

mkdir -p "$ROOT/logs"

run_model "qwen3.8:27b" "$ROOT/logs/persona-qwen.log" &
run_model "gemma4:31b-128k" "$ROOT/logs/persona-gemma.log" &

wait

echo "persona round done $(date)" >> "$ROOT/logs/persona-qwen.log"
