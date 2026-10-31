#  002: The memory recall test

Can a local Hermes memory plugin, embedding with `bge-m3`, answer
paraphrased "that time we talked about X" questions over an agent's
past? Two agent harnesses, Hermes Agent and OpenClaw, each in a
keyword-only mode and an embedding mode, against the same synthetic
corpus and the same 240 held-out queries, three seeds each. Then a
blind rating of whether a friendlier personality preset changes how
the agent feels.

**Read the report:** [The memory recall test][report], published Oct.
2026.

[report]: https://saxby-tools.github.io/lab/reports/002-memory-recall/

This folder holds everything behind it: the fact bank, the generator,
the three corpora, the harness for each cell, every ranked result, the
scorer, and the personality packet.

##  Results

| Cell | What | at 1 | at 5 | at 10 | 95 percent interval at 5 |
| --- | --- | --- | --- | --- | --- |
| A0 | Hermes FTS5, exact fact text (control) | 100.0 | 100.0 | 100.0 | 100.0 to 100.0 |
| A1 | Hermes FTS5, as typed | 4.2 | 17.2 | 35.7 | 14.6 to 19.8 |
| A2 | Hermes FTS5, content words OR | 0.4 | 1.4 | 1.9 | 0.0 to 3.0 |
| B0 | Hermes LanceDB bge-m3, exact fact text (control) | 100.0 | 100.0 | 100.0 | 100.0 to 100.0 |
| B1 | Hermes LanceDB bge-m3, vector | 47.1 | 68.6 | 75.4 | 65.3 to 71.9 |
| B2 | Hermes LanceDB bge-m3, hybrid | 33.1 | 65.1 | 73.2 | 63.0 to 67.3 |
| C0 | OpenClaw bge-m3 hybrid, exact fact text (control) | 36.9 | 55.8 | 60.3 | 50.4 to 61.3 |
| C1 | OpenClaw keyword only | 1.0 | 3.9 | 4.7 | 1.5 to 6.3 |
| C2 | OpenClaw bge-m3 hybrid | 1.7 | 4.3 | 4.7 | 1.7 to 6.9 |
| C3 | OpenClaw bge-m3 hybrid, no score cut (post hoc) | 4.7 | 15.3 | 21.1 | 12.3 to 18.3 |
| C4 | OpenClaw bge-m3 hybrid, undated notes (post hoc) | 5.8 | 16.2 | 24.3 | 10.8 to 21.7 |
| C4-control | OpenClaw bge-m3 hybrid, undated, exact fact text (post hoc) | 91.1 | 99.7 | 100.0 | 98.5 to 100.0 |
| C5 | OpenClaw bge-m3 hybrid, undated, no score cut (round 4) | 9.6 | 38.8 | 60.0 | 36.7 to 40.8 |
| B3 | Hermes LanceDB bge-m3, extracted facts, vector (round 3) | 0.0 | 0.0 | 0.0 | 0.0 to 0.0 |
| B4 | Hermes LanceDB bge-m3, extracted facts, hybrid (round 3) | 0.0 | 0.0 | 0.0 | 0.0 to 0.0 |
| B5 | Hermes LanceDB bge-m3, facts and turns, vector (round 3) | 47.1 | 68.6 | 75.4 | 65.3 to 71.9 |
| B6 | Hermes LanceDB bge-m3, extracted facts, vector, shim (round 3) | 70.4 | 89.4 | 92.2 | 82.1 to 96.8 |
| B7 | Hermes LanceDB bge-m3, extracted facts, hybrid, shim (round 3) | 40.1 | 84.3 | 91.5 | 76.7 to 91.9 |
| B8 | Hermes LanceDB bge-m3, facts and turns, vector, shim (round 3) | 72.9 | 90.1 | 93.8 | 84.4 to 95.8 |

Recall at k, percent, mean of three seeds. Chance at five of 30 notes is 16.7.

##  What's here

```
index.md             the report, in Markdown; the site builds it
README.md            this file
data.md              what every file holds, versions, and every change
preregistration.md   the rules set before any run
*.11tydata.json      the site's settings: chart colors
checks/              a test of every number in the report against the
                     data
recall/              the recall arm
  facts.json         120 invented facts, each with two held-out queries
  filler.json        the mundane sentences padded around them
  words.py           the crude stemmer the checks share
  generate.py        builds one seeded corpus
  check.py           refuses any query that shares a word with its note
  corpus/seed-N/     the three generated corpora, as they ran
  hermes-fts.py      cells A0 to A2, Hermes session_search
  hermes-lancedb.py  cells B0 to B2, the LanceDB plugin with bge-m3
  hermes-lancedb-facts.py
                     round 3, cells B3 to B8: the plugin with its fact
                     extraction on, as shipped and with the shim
  openclaw.py        cells C0 to C5, OpenClaw memory_search
  corpus.py          shared loading and the exact-text controls
  score.py           recall at k, intervals, miss lists
  tables.py          prints the report's table rows from the summary
  run.sh             reruns everything from a clean checkout
  results/seed-N/    one JSON line per query per cell, and round 3's
                     extracted facts per note
  results/summary/   the tables the report quotes
personality/         the personality arm
  config.yaml        the Hermes config each sample starts from
  SOUL.md            the fixed persona under every preset
  run.py             asks the same line under each preset
  packet.py          shuffles the replies for a blind rating
  replies/           every reply and the full CLI output behind it
  packet.md          the blind packet
  ratings.md         Niko's blind ratings, the key and the means
  key.json           the key, committed after the ratings were given
```

##  Rerun it

You need Docker, the `openclaw` CLI (2026.10.9) on your PATH, Ollama
on `127.0.0.1:11434` with `bge-m3` pulled, and Python 3. The Hermes
cells run inside the pinned `nousresearch/hermes-agent:v0.22.5` image
and reach Ollama on the host as `host.docker.internal`.

Check the corpora first. Every query must share no content word with
its gold note:

```bash
python3 recall/check.py recall/corpus/seed-1 recall/corpus/seed-2 recall/corpus/seed-3
```

Regenerating a corpus from the same seed gives the same files:

```bash
python3 recall/generate.py --seed 1 --out /tmp/seed-1 && diff -r /tmp/seed-1 recall/corpus/seed-1
```

Build the Hermes home template once, then run the cells. Each seed
rebuilds every index from empty; the OpenClaw cells take about ten
minutes a seed because the CLI starts a Node process per query:

```bash
recall/run.sh setup
```

```bash
for s in 1 2 3; do recall/run.sh hermes $s; done
```

```bash
for s in 1 2 3; do recall/run.sh openclaw $s; done
```

Round 3 also needs Saxby on `127.0.0.1:11435` with `gemma4:31b-128k`
behind it, and takes about an hour a seed, most of it the model
extracting facts:

```bash
for s in 1 2 3; do recall/run.sh facts $s; done
```

```bash
recall/run.sh score
```

The runners overwrite `recall/results/`. Embeddings are deterministic
for the same model file, so cells B0 to B5 and the C cells should
reproduce the committed numbers; the A cells are plain SQLite and
will. The extracted facts are sampled from a model and will differ,
so B6 to B8 will land near the committed numbers, not on them.

Check every number in the report and this README against the data,
from the repository's root after `npm ci`:

```bash
npm test
```

The personality arm needs Saxby on `127.0.0.1:11435` with
`gemma4:31b-128k` behind it, and the model samples freely, so new
replies will differ:

```bash
python3 personality/run.py --work /tmp/report-002
```

##  Corrections

None yet.

##  Known gaps

None open. [#9](https://github.com/saxby-tools/lab/issues/9), the
personality ratings, closed the same evening when they came in; see
`personality/ratings.md`.

Both follow-up rounds ran the same night and are in the report:
[#10](https://github.com/saxby-tools/lab/issues/10), the LanceDB plugin
with extraction on, is round 3, and
[#11](https://github.com/saxby-tools/lab/issues/11), OpenClaw with the
score cut removed, is round 4. The extraction bug round 3 found is
filed upstream as
[lancedb/hermes-agent-memory#14](https://github.com/lancedb/hermes-agent-memory/issues/14).
