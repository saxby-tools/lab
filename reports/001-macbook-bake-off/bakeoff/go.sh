#!/bin/bash
#
# Runs the whole bake-off, one model at a time, then measures memory.

set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG="$ROOT/logs/run.log"

MODELS=(
  "qwen3-coder-next:latest"
  "laguna-xs-2.1"
  "qwen3.8:27b"
  "gemma4:31b-128k"
  "laguna-s-2.1"
)

mkdir -p "$ROOT/logs"
echo "start $(date)" >> "$LOG"

for model in "${MODELS[@]}"; do
  deno run -A --no-config --no-lock "$ROOT/run.ts" "$model" >> "$LOG" 2>&1
  echo "model done $model $(date)" >> "$LOG"
done

deno run -A --no-config --no-lock "$ROOT/measure.ts" "${MODELS[@]}" \
  >> "$LOG" 2>&1

echo "all done $(date)" >> "$LOG"
