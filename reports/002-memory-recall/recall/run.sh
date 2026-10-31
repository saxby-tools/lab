#!/bin/bash
# Rerun the memory recall cells from a clean checkout.
#
#   run.sh setup            build the Hermes home template: the LanceDB
#                           plugin at its pinned commit and its deps
#   run.sh hermes SEED      cells A0, A1, A2, B0, B1, B2 in the pinned
#                           Hermes container
#   run.sh openclaw SEED    cells C0, C1, C2 with the host's openclaw CLI
#   run.sh facts SEED       round 3, cells B3 to B8: the plugin's fact
#                           extraction through the chat model, as
#                           shipped and then with the shim; about an
#                           hour a seed on an M5 Max
#   run.sh score            summary tables under results/summary/
#
# Needs Docker, the openclaw CLI on PATH, and Ollama on 127.0.0.1:11434
# with bge-m3 pulled. The facts target also needs Saxby on 11435 with
# gemma4:31b-128k behind it. WORK (default: ./work, ignored by git)
# holds the throwaway Hermes and OpenClaw homes.
#
# Licence: AGPL-3.0-or-later.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HERE/work}

IMAGE=nousresearch/hermes-agent:v0.22.5
PLUGIN=lancedb/hermes-agent-memory
PLUGIN_REF=6691591e62e10438ee32ff671afad337208fdd43
PLUGIN_DEPS="lancedb==0.41.0 openai==3.41.0 pyarrow==26.0.0 pyyaml==6.0.3"

# The image's uv refuses packages newer than its own build date; the
# pins above are what resolved on Oct. 30, 2026, so lift the cutoff.
UV_CUTOFF=2026-10-31T00:00:00Z

PYTHON=/opt/hermes/.venv/bin/python
SITE=/opt/data/site-packages

hermes_container() {
    home=$1
    shift
    docker run --init --rm \
        -e "HERMES_UID=$(id -u)" -e "HERMES_GID=$(id -g)" \
        -v "$home:/opt/data" -v "$HERE:/work" \
        "$IMAGE" bash -c "$*" 2>&1 | grep -v '^\[stage2\]\|^  + \|^Syncing\|^Done:'
}

setup() {
    base=$WORK/hermes-base
    rm -rf "$base"
    mkdir -p "$base"
    hermes_container "$base" \
        "hermes plugins install $PLUGIN --ref $PLUGIN_REF" \
        "&& uv=\$(find /opt/hermes/tools -maxdepth 3 -name uv -type f | head -1)" \
        "&& \$uv pip install --exclude-newer $UV_CUTOFF" \
        "--python $PYTHON --target $SITE $PLUGIN_DEPS" \
        "&& cd /opt/data/plugins/lancedb && git rev-parse HEAD"
}

hermes() {
    seed=$1
    home=$WORK/hermes-seed-$seed
    rm -rf "$home"
    cp -R "$WORK/hermes-base" "$home"
    hermes_container "$home" \
        "cd /opt/hermes && HERMES_HOME=/opt/data $PYTHON /work/hermes-fts.py" \
        "--corpus /work/corpus/seed-$seed --out /work/results/seed-$seed"
    hermes_container "$home" \
        "cd /opt/hermes && HERMES_HOME=/opt/data OLLAMA_API_KEY=ollama" \
        "PYTHONPATH=/opt/hermes:$SITE $PYTHON /work/hermes-lancedb.py" \
        "--corpus /work/corpus/seed-$seed --out /work/results/seed-$seed"
}

openclaw() {
    seed=$1
    python3 "$HERE/openclaw.py" --corpus "$HERE/corpus/seed-$seed" \
        --out "$HERE/results/seed-$seed" --home "$WORK/openclaw-seed-$seed" \
        --mode none &
    python3 "$HERE/openclaw.py" --corpus "$HERE/corpus/seed-$seed" \
        --out "$HERE/results/seed-$seed" --home "$WORK/openclaw-seed-$seed" \
        --mode ollama --control
    wait
}

facts() {
    seed=$1

    for variant in shipped shim; do
        home=$WORK/hermes-facts-seed-$seed-$variant
        flag=""

        if [ "$variant" = shim ]; then
            flag="--shim"
        fi

        rm -rf "$home"
        cp -R "$WORK/hermes-base" "$home"
        hermes_container "$home" \
            "cd /opt/hermes && HERMES_HOME=/opt/data OLLAMA_API_KEY=ollama" \
            "PYTHONPATH=/opt/hermes:$SITE $PYTHON" \
            "/work/hermes-lancedb-facts.py $flag" \
            "--corpus /work/corpus/seed-$seed --out /work/results/seed-$seed"
    done
}

score() {
    python3 "$HERE/score.py" --results "$HERE/results"
}

case "${1:-}" in
    setup) setup ;;
    hermes) hermes "$2" ;;
    openclaw) openclaw "$2" ;;
    facts) facts "$2" ;;
    score) score ;;
    *) sed -n '2,15p' "$0"; exit 1 ;;
esac
