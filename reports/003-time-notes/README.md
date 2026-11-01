#  003: Time notes on resumed conversations

When you come back to a chat the next afternoon, does the model know
the night has passed? Six ways of telling a local model the time, from
nothing at all to a note on every message, against 30 resumed
conversations, three seeds each, with the cost to the prompt cache
measured on the same turn.

**Read the report:** [Time notes on resumed conversations][report],
Nov. 2026.

[report]: https://saxby-tools.github.io/lab/reports/003-time-notes/

This folder holds everything behind it: the fixtures, the harness,
every reply the model gave with its cache counts, the scorer, and the
checks.

##  Results

| Arm | What | Right | After | Before | UNKNOWN | Uncached tokens | 95 percent interval |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Nothing: no time anywhere | 88.3 | 87.8 | 88.9 | 88.3 | 89 | 81.2 to 95.5 |
| B | Date once, in the system prompt, never updated | 30.0 | 0.0 | 60.0 | 38.9 | 90 | 22.8 to 37.2 |
| B2 | Date fresh, in the system prompt, every turn | 30.0 | 3.3 | 56.7 | 42.2 | 189 | 25.9 to 34.1 |
| E | Note on the latest user message only | 82.2 | 80.0 | 84.4 | 8.3 | 237 | 79.8 to 84.6 |
| D | Note on every user message | 80.0 | 77.8 | 82.2 | 8.3 | 107 | 71.7 to 88.3 |
| E2 | Note on the latest message, plus the gap | 85.6 | 86.7 | 84.4 | 9.4 | 247 | 83.2 to 87.9 |

Right answers on the forced-choice resume, percent, mean of three
seeds; "After" and "Before" split the resumes by whether the window
had closed. For arm A the right answer is UNKNOWN, so its "Right" is
its UNKNOWN rate. Uncached tokens are the prompt tokens the runner
processed again on the resume turn. Verdict on arm E at the
preregistered bar: **inconclusive**.

##  What's here

```
index.md             the report, in Markdown; the site builds it
README.md            this file
data.md              what every file holds, versions, and every change
preregistration.md   the rules set before any run, with the one change
                     made before the first run
*.11tydata.json      the site's settings: layout, chart colors
checks/              a test of every number in the report against the
                     data
timenotes/           the harness
  fixtures.json      30 resumed conversations with simulated times
  check.py           refuses close fixtures; derives the answer key
  render.py          builds each arm's warm and resume requests
  run.py             drives Ollama and records replies and counts
  score.py           accuracy, honesty, echo, callbacks, cost, verdict
  tables.py          prints the report's table rows from the summary
  survey.py          builds the blind packet below; the key goes
                     outside the repo
  run.sh             reruns everything from a clean checkout
  results/seed-N/    one JSON line per resume request, per arm
  results/summary/   the tables the report quotes
survey/              a blind packet: 30 pairs of open-resume replies,
                     arm A against arm E, for a human rater
```

##  Rerun it

You need Ollama on `127.0.0.1:11434` with `gemma4:31b-128k` pulled,
and Python 3.11 or later. Nothing else should use the model while a
seed runs, because the cost column reads the prompt cache.

Check the fixtures first:

```bash
timenotes/run.sh check
```

Then the three seeds, about 45 minutes each on an M5 Max:

```bash
for s in 1 2 3; do timenotes/run.sh seed $s; done
```

```bash
timenotes/run.sh score
```

A seed skips rows it already has, so delete `timenotes/results/seed-N`
to start one over. The model samples at its own temperature with the
seed fixed, so a rerun on the same build and digest should reproduce
the replies; a different build will land near the numbers, not on
them. The cache counts depend on the runner and will differ on another
version.

Check every number in the report and this README against the data,
from the repository's root after `npm ci`:

```bash
npm test
```

##  Blind survey

`survey/packet.md` shows 30 open resumes on the "after" side, seed 1,
with the replies from arm A and arm E as X and Y in an order drawn at
random per pair. The rater answers one question per pair, which reply
reads as though the writer knows the named time has passed, in
`survey/ratings.md`. The key stays outside the repo until the ratings
are in, then both are added here with a dated note.

##  Corrections

None yet.

##  Known gaps

One open, found while scoring:

- [#13](https://github.com/saxby-tools/lab/issues/13): a note between
  midnight and 5 a.m. says "night on Monday" for 1:30 a.m. Monday, and
  the model reads that as the end of Monday. Three fixtures hit it.
  The fix is in the next round's renderer, not a change to this one.

[#14](https://github.com/saxby-tools/lab/issues/14) asked whether the
all-or-nothing cache reuse was the runner's rule or this build's. It
closed the morning after: it is llama.cpp's rule for sliding-window
and hybrid models such as Gemma 4 and Granite 4, confirmed against the
runner directly and in its log; a full-attention model reuses the
common prefix. The report's cache section carries the numbers.

The next round, every-message notes with the night fixed, is
[#15](https://github.com/saxby-tools/lab/issues/15).
