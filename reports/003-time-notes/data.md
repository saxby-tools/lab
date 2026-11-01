#  Data: time notes on resumed conversations

What every file holds, how it was collected, what was checked, and
every change made since it was recorded.

##  At a glance

| Arm | Runs | Folder |
| --- | --- | --- |
| Six arms, forced-choice resume | 3 seeds, 60 resumes each per arm | `timenotes/results/seed-N/<arm>.jsonl` |
| Open resume, what-day control, repeat floor | 3 seeds, 100 more rows per arm | same files, `variant` field |
| Round 2: five arms, 44 fixtures, all variants | 3 seeds, 230 rows per arm | `timenotes/results/round-2/seed-N/<arm>.jsonl` |
| Embedding probe | 4 conditions, 3 seeds of drawn times | `timenotes/results/embed-probe/summary.json` |
| Round 3: four arms, 40 zoned fixtures, all variants | 3 seeds, 210 rows per arm | `timenotes/results/round-3/seed-N/<arm>.jsonl` |

Everything ran on one machine: an Apple M5 Max with 128 GiB of unified
memory, macOS 26, Ollama 0.40.13 with Saxby's patches, between 1:33
a.m. and 2:44 a.m. on Nov. 1, 2026, with nothing else using the model.
One runner process, started the evening before, served every request
of the night. The run crossed the end of daylight saving time at 2
a.m.; `recorded_at` carries the UTC offset, so the rows' clock time
steps back an hour partway through seed 1, and the simulated times
are rendered with zone rules, so none of them is affected.

##  Versions

Pinned before the first run.

| Piece | Version |
| --- | --- |
| Ollama | 0.40.13+saxby.ad4b55d8 (the ollama-saxby build); the llama.cpp `llama-server` runner, which `ollama ps` reports as `llamacpp`, one slot, flash attention on, KV cache q8_0 |
| Model | `gemma4:31b-128k`, Ollama digest `d0e8710a4e62152ad73c32a84f8b025d2b7fe044d405d8ed1b38cb3e9d066d32`, 31.3B parameters, Q4_K_M, `num_ctx` 131072 |
| Sampling | the model's own defaults: temperature 1, top_k 64, top_p 0.95; `num_predict` 200; thinking off; `seed` set to the seed number |
| Host Python | 3.15.2, standard library only |
| Time zone | America/New_York for every rendered date |

##  Fixtures

`timenotes/fixtures.json` holds 30 conversations. Each has three
scripted turns, user, assistant, user, with a simulated time on every
user message; the second user message names a thing and a window for
it. The file also records when the window opens and closes, a resume
time after it closes and a resume time before it opens, the resume
question for that fixture, and a keyword list for the callback count.
The shared persona, the forced-choice tail, the open resume and the
what-day control are in the same file. The simulated times run from
Oct. 19 to Nov. 2, 2026; three resumes fall between midnight and 5
a.m.

`timenotes/check.py` refuses a fixture whose turns are out of order,
whose "before" resume is less than three hours after the last message
or less than two hours before the window opens, or whose "after"
resume is less than two hours after the window closes. It also checks
that a keyword appears in the user's own words. The answer key, PASSED
after and AHEAD before, follows from the times. All 30 pass.

Nothing in a fixture is copied from a real conversation. One fixture,
F01, was tightened before the run: its first draft said "some time
this week, maybe tonight," which names two windows, and the smoke
test's reply pointed that out.

##  How a resume was measured

`timenotes/render.py` builds two requests per resume.

The **warm** request is the previous turn as the arm would have sent
it: the persona, the arm's own time text, and the scripted turns up to
the last user message. The model answers it for real, with the same
seed, and that reply is kept. Each warm request puts the previous
turn's prompt and reply in the runner's cache, as a real client's
previous turn would have.

The **resume** request is what the arm sends next: the same turns as
the arm renders them now, the model's own reply from the warm request,
and the resume message. In arm E the note that sat on the previous
user message is gone and a new one sits on the resume; in D every
earlier note stays; in B2 the date line in the system prompt is
re-rendered; in A and B nothing earlier changes.

`timenotes/run.py` sends both to Ollama's native `/api/chat` with
`stream: false`, and records for the resume: the reply, the prompt
token count, the count the runner says it took from its cache, their
difference, the generation count, the durations, and the warm
request's counts beside them. Rows are appended to
`results/seed-N/<arm>.jsonl`; a rerun skips rows already written.
`provenance.json` in each seed folder holds the Ollama version and
the model digest the rows were made with.

Per arm and seed: 60 forced-choice resumes (30 fixtures, after and
before), 60 open resumes, 30 what-day controls on the "after" side,
and the repeat floor on five fixtures, where the same resume is sent
twice and the second one's uncached count is the least the runner
will charge for any request.

`timenotes/score.py` reads the first word of each forced reply with
one regular expression, scores it against the key (UNKNOWN for arm A,
the key for the rest), and writes `results/summary/summary.json` and
`summary.md`. `tables.py` prints the rows the report quotes;
`checks/numbers.test.js` checks every arm row on the pages against
the summary.

##  Record fields

| Field | Meaning |
| --- | --- |
| `arm`, `fixture`, `variant`, `side`, `repeat`, `seed` | Which arm, fixture (`F01` to `F30`), variant (`forced`, `open`, `control`, `floor`), side (`after` or `before` the window), repeat (0, or 1 for the floor's second send) and seed |
| `resume_at` | The simulated time of the resume |
| `key` | PASSED for `after`, AHEAD for `before`; arm A is scored against UNKNOWN |
| `system_changed` | Whether the system prompt differs between the warm and resume requests (true only in B2) |
| `system_sent`, `resume_sent` | The system prompt and the resume message exactly as sent |
| `prior_reply` | The model's reply to the warm request, placed before the resume |
| `reply`, `thinking` | The model's reply to the resume; `thinking` is always empty with thinking off |
| `warm` | The warm request's counts: prompt tokens, cached, uncached, generated |
| `prompt_eval_count`, `prompt_eval_cached_count`, `uncached` | The resume's prompt tokens, how many the runner took from its cache, and the difference |
| `eval_count`, `prompt_eval_ms`, `eval_ms`, `wall_ms`, `done_reason` | Generation count and timings |
| `ollama_version`, `model`, `model_digest`, `recorded_at` | What answered, and when |

##  What was checked

- `check.py` on the fixtures: 30 pass, none refused.
- Before the night, the runner's cache reporting was probed by hand
  with the same short conversation sent in seven shapes. An identical
  resend reported 134 of 139 prompt tokens cached. A prompt that
  extended the cached one reported 105 of 141. A prompt that differed
  inside the cached span, even by one message, reported zero. A warm
  request that ended on an assistant message was never extended,
  because the template treats a trailing assistant message as text
  for the model to continue. That probe is why the warm request is a
  real previous turn, recorded under "Decided after the plan" in the
  preregistration before the first run.
- The cached count is reported on both of Ollama's APIs:
  `prompt_eval_cached_count` on `/api/chat`, and
  `usage.prompt_tokens_details.cached_tokens` on the OpenAI-compatible
  endpoint. `prompt_eval_count` includes the cached tokens, so the
  cost of a turn is the difference.
- The smoke test, one fixture through every arm, showed the cache
  split the design expected before the night ran: A, B and D extended
  the cached prompt; B2, E and E2 did not.
- After the run: 160 rows in each of the 18 arm files, 2,880 in all,
  every one with `done_reason` `stop`. Every forced reply opened with
  one of the three words, and no reply in any arm opened a bracket
  with "It is". E and E2 reported zero cached tokens on 180 of 180
  forced resumes; B2 on 168, the 12 exceptions being the same-day
  resumes whose date line did not change; A, B and D on none.
- `summary.json` was regenerated once after the run, for a heading
  change in `score.py` (below), and compared byte for byte with the
  first: identical.
- The morning after, the cache rule was probed again: the same
  `llama-server` process on its own port with `/completion` and
  `cache_prompt` on, a 238-token prompt in five shapes, reading
  `timings.cache_n`; then `granite4:micro-h` and `voxtral-mini-3b:32k`
  through `/api/chat` in the same shapes. Gemma 4 and Granite 4
  reported zero on any change inside the prompt; Voxtral reused the
  common prefix. The runner's log names the cause: a forced full
  reprocess "due to lack of cache data (likely due to SWA or
  hybrid/recurrent memory)", with `is_swa_any = 1` for gemma4 and
  checkpoints spaced 8,192 tokens apart. The tables are on
  [#14][gap-cache].

##  Known limits of the setup

- The clock is simulated. Dates and dayparts come from the fixture's
  times, rendered by the same function a Saxby feature would use. The
  runner's cache, by contrast, is real, and so is the model.
- One model, one quantisation, one runner. The cache rule found here
  is the llama.cpp runner's as Ollama 0.40.13 drives it, and a
  different runner, or a later version, can reuse prefixes
  differently.
- The forced-choice opener is an instruction the user would not type.
  It buys a score no model judges. The open resume, counted for
  callbacks only, is the natural case.
- Thinking is off. A thinking pass might reason its way to the right
  answer more often, at a cost in time this night did not budget for.
- The what-day control and the callback count are string matches: a
  weekday and a daypart word, and a fixture's keywords. They say
  whether the words appear, not how well the reply reads.
- The note calls 21:00 to 05:00 "night" and pairs it with the calendar
  date, so 1:30 a.m. Monday reads "night on Monday". Three fixtures
  resume in those hours and the note arms did badly on them; the split
  by daypart was not preregistered. [#13][gap-night] tracks it.
- The all-or-nothing cache reuse is llama.cpp's behaviour for
  sliding-window and hybrid models, not this build's; a full-attention
  model reuses the common prefix. Closed on [#14][gap-cache] with the
  probe tables.

[gap-night]: https://github.com/saxby-tools/lab/issues/13
[gap-cache]: https://github.com/saxby-tools/lab/issues/14

##  Round 2

Preregistered in `preregistration.md` under "Round 2" at noon on
Nov. 1, amended at 12:40 p.m., both before the first round 2 run,
which went from 12:25 p.m. to 2:54 p.m. the same day. Same Ollama
build and model digest, checked before the run; the same runner
process that served the morning probes. Nothing else used the model.

`timenotes/fixtures-round-2.json` holds 14 fixtures and includes
`fixtures.json` by reference, so the 30 are never copied: F31 to F36
resume between midnight and 5 a.m., F37 to F40 name a weekday and
resume on that weekday a week later, F41 to F44 resume three to seven
weeks after the window. `check.py` accepts the included file; all 44
pass. The verdict reads from F01 to F40; F41 to F44 are reported
beside it. The ten added to the verdict set were written after round
1's misses were known and target them.

Arms DC, DCG, DWG, DIG and EC are rendered by the same `render.py`,
which still renders round 1's six arms byte for byte: every round 1
row's `system_sent` and `resume_sent` were rebuilt from the fixtures
and compared, 900 rows, none differed. Round 2 notes carry the time a
proxy would first have seen the message (`first_seen()` in the
renderer), which for these fixtures equals the message's own time.
The gap sentence counts hours under two days, then days, weeks and
months; round 1's E2 keeps hours.

Per arm and seed: 88 forced resumes, 88 open, 44 controls, 10 floor
rows. `score.py --round 2` adds, per arm, the accuracy on the
after-midnight resumes against the rest, on round 1's 30 fixtures
alone, on the week-on "after" resumes, and on the long-gap fixtures.
Round 1's summary is reproduced byte for byte by the same scorer.

What was checked after the run: 230 rows in each of the 15 files,
3,450 in all, every `done_reason` `stop`; every forced reply opened
with one of the three words; no reply opened a bracket with "It is";
the every-message arms reported a nonzero cached count on all 264
forced resumes each, and EC reported zero on all 264. The what-day
control's string match undercounts the clock arms: with a clock in
the note the model often answers "It's Sunday at noon" or "Wednesday
night," outside the four daypart words; the wrong-weekday count is
the number to read there, 0 of 132 for every arm but DIG, 11 for DIG.

##  Round 3

Preregistered in `preregistration.md` under "Round 3" at 3:37 p.m.
on Nov. 1, before any round 3 fixture, renderer change or run; the
header's hour was misstated in that commit and corrected two minutes
later. The run went from 3:46 p.m. to 5:31 p.m. the same day on the
same build, digest and runner process. Nothing else used the model.

`timenotes/fixtures-round-3.json` holds 40 fixtures and inherits
round 1's settings without its fixtures. The file names the host zone,
America/New_York, and four sender zones; each fixture names its
sender's zone and a family, and its message times, window and resumes
are in the sender's local clock. `timenotes/zones.py` computes, for
each resume, the answer in each of the five candidate zones; the key
is the sender-zone answer, or UNKNOWN for an "unknown" fixture when
the candidates disagree. `check.py` applies the usual margins in the
sender's zone and prints every key; all 40 pass, with 21 resumes
keyed UNKNOWN. Arm ZS, whose note is in the sender's zone, is keyed
to the sender-zone answer throughout.

The renderer converts each message's first-seen moment and the resume
into the arm's note zone before rendering; ZN adds the zone's
abbreviation from the zone database (`EST`), ZO the offset. Rounds 1
and 2 still render byte for byte (2,000 rows rebuilt and compared),
and their summaries are byte-identical under the extended scorer.

Rows carry four more fields: `zone`, `family`, `note_zone` and
`zone_matters`. The what-day control is scored against the weekday
and daypart in the arm's note zone, since that is what the note says.
A reply "asks" when it contains a question mark and a place or zone
word; the regular expression is in `score.py`.

What was checked after the run: 210 rows in each of the 12 files,
2,520 in all, every `done_reason` `stop`; every forced reply opened
with one of the three words; every arm reported a nonzero cached
count on all 240 forced resumes; no reply in any arm asked where the
user was, by the regular expression or by reading every reply that
mentions a zone, a city or "where you".

##  Embedding probe

`timenotes/embed-probe.py`, run at 2:56 p.m. on Nov. 1 with `bge-m3`
through Ollama's `/api/embed`. Rows are report 002's 120 invented
facts from `reports/002-memory-recall/recall/facts.json`; queries are
their 240 held-out paraphrases, embedded once, plain. Each fact is
embedded four ways: as is, and with a daypart, clock or ISO note in
front, the time drawn per fact over six weeks from the seed. Recall
at 1, 5 and 10 over the 120 rows, the mean cosine gap between the
right row and the best wrong row, and the mean cosine between any two
rows. Each row is one sentence, so recall runs far higher than
report 002's chunked diary; the differences between conditions are
the result, not the levels.

##  Changes since recording

- **Nov. 1, 2:50 a.m.** `score.py` wrote the extras section of
  `summary.md` under the heading "Seed 1 extras", left from the plan
  before the open resume, the what-day control and the repeat floor
  ran on every seed. The heading now says "Extras, all seeds". No
  number changed; `summary.json` is byte-identical before and after.
- **Nov. 1, late morning.** The report's cache section gained the
  reason for the all-or-nothing reuse, from the morning probe above,
  and its limits bullet on the runner was reworded to match. No row
  and no number changed.
- **Nov. 1, afternoon.** Round 2 and the embedding probe were added
  to the report as their own sections, two bars joined the chart,
  and the deck, the limits and the take gained a paragraph each.
  Round 1's rows, summary and verdict are untouched.
- **Nov. 1, evening.** Round 3 was added as its own section, one bar
  joined the chart, and the deck, the limits and the take gained a
  paragraph each. Rounds 1 and 2 are untouched.
