<!-- lab:label {
  "number": "Saxby lab report No. 002",
  "top": "The memory",
  "word": "Recall test",
  "bottom": "Tested with great care"
} -->

# The memory recall test

<!-- /lab:label -->

<!-- lab:deck -->

I am deciding whether to move my agent from OpenClaw to Hermes Agent,
and the sticking point is memory. Hermes searches its past by keyword;
OpenClaw by meaning. Does a local plugin close that gap? I built a
fake six-week diary, wrote 240 questions that share no words with the
entries they ask about, and ran four search setups against it three
times each. **Hermes with the LanceDB plugin and `bge-m3` found the
right day for about two questions in three. The bar I set was nine in
ten.** Hermes on its own scored at chance. OpenClaw, with the same
embedder, scored at chance too, and missed the verbatim sentence
almost half the time. **Two follow-up rounds ran the same night. The
plugin's own path, with fact extraction on, reached 89 percent once a
small incompatibility with this Hermes was patched; as shipped, it
extracted nothing.** OpenClaw with its two defaults set aside got to
39.

<!-- /lab:deck -->

<!-- lab:bar-chart {
  "value": "Recall at 5",
  "title": "Paraphrased questions answered in the top five, percent, mean of three seeds",
  "max": 100,
  "marker": {"at": 90, "label": "The bar: 90"},
  "details": true
} -->

| Setup | Recall at 1 | Recall at 5 | Recall at 10 |
| --- | --- | --- | --- |
| Hermes LanceDB, facts, patched (round 3) | 70.4 | 89.4 | 92.2 |
| Hermes LanceDB, vector | 47.1 | 68.6 | 75.4 |
| Hermes LanceDB, hybrid | 33.1 | 65.1 | 73.2 |
| Hermes FTS5, as typed | 4.2 | 17.2 | 35.7 |
| Hermes FTS5, OR | 0.4 | 1.4 | 1.9 |
| OpenClaw keyword | 1.0 | 3.9 | 4.7 |
| OpenClaw hybrid | 1.7 | 4.3 | 4.7 |

<!-- /lab:bar-chart -->

Guessing five of the 30 days at random scores 16.7 percent.

## Why I ran it

My agent, Aster, runs on OpenClaw. A research note on Oct. 30 found
that Hermes Agent wins most of what I want from a harness: a chat API
that streams tool activity, approvals that reach my phone, a quarter
of the prompt overhead. It also found the catch. Hermes's built-in
recall over past sessions is SQLite full-text search with no stemming
and no vectors. Ask it about "that time we talked about the tap" and
it needs the word "tap" to be in the transcript. OpenClaw searches by
meaning out of the box, through the same `bge-m3` embedder I already
run.

Hermes has memory plugins that add vectors. The question I wanted a
number for: does one of them, running locally with my own embedder,
answer paraphrased questions about an agent's past? And a second
question I half believed the answer to: if the memory is shallow, can
a friendlier personality hide it? "It's all an illusion anyway."

Everything that follows was set down before any run, in
[preregistration.md][prereg]: the hypotheses, the pass bar, the metric,
the cells and the number of seeds.

[prereg]: https://github.com/saxby-tools/lab/blob/HEAD/reports/002-memory-recall/preregistration.md

## How the test works

**A fake diary.** A fictional person, Mara, keeps dated notes for six
weeks: 30 notes, four invented facts each, padded with mundane filler
about porridge and bus rides until each note runs to about 700 words.
No real memory file went anywhere near this. The same 120 facts appear
in every run; a seed decides which day each fact lands on and what
surrounds it.

**Questions that share no words.** Every fact carries two held-out
questions written the way you ask an assistant about something from
weeks ago, with different vocabulary on purpose. The fact says "the
plumber swapped the cartridge in the kitchen faucet"; the question
asks "when did the tap in the cooking area stop leaking?" A check
script compares word stems and refuses any question that shares a
content word with its day's note or with any filler sentence. All 240
pass.

**Four search setups, two harnesses.** Each harness sees the diary in
its own native shape and is searched through its own code, not a
reimplementation:

- **Hermes FTS5.** Each note becomes one past session in Hermes's
  SQLite store, one user message per paragraph. Hermes's
  `session_search` tool function runs each question, once as typed
  and once as its content words joined with `OR`, the broadening its
  own no-match message recommends.
- **Hermes LanceDB plugin.** The [LanceDB memory plugin][lancedb],
  Apache-2.0, with `bge-m3` through Ollama's OpenAI-compatible
  embeddings endpoint. Every paragraph and every acknowledgement goes
  in as a turn row, the way the plugin's own `sync_turn` stores them,
  and the plugin's `recall()` runs in its default vector mode and in
  hybrid mode. The plugin's model-based fact extraction was turned
  off so that every setup indexes the same words.
- **OpenClaw keyword.** The notes are copied in as `memory/*.md` and
  searched with `openclaw memory search` with `provider: "none"`.
- **OpenClaw hybrid.** The same, with `provider: "ollama"` and
  `bge-m3`: vectors plus BM25, OpenClaw's default for a personal
  agent.

[lancedb]: https://github.com/lancedb/hermes-agent-memory

**The score.** A question counts when the day it asks about is among
the first five items the search returns, items being whatever the
tool hands the agent: sessions for Hermes FTS5, rows for LanceDB,
chunks for OpenClaw. No model judges anything; it is a string match on
the day. Three seeds, every index rebuilt from empty each time.

**The bar,** in my own words from before the run: on ten paraphrased
questions, zero or one miss is a go, three or more is a fail. Applied
to the full set, 90 percent or better is a go, 70 percent or worse a
fail, and the verdict is read from the hybrid cell.

**A control.** Each setup was also asked every fact's own sentence,
word for word. All three scored 100 percent on every seed. The indexes
work; what follows is about paraphrase.

## What the numbers say

<!-- lab:data-table -->

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

Recall at k, mean of three seeds, percent. The interval is a
t-interval over the three seed means; with three seeds it is wide by
construction. Seed-to-seed spread was small: the LanceDB vector cell
scored 69.6, 67.1, 69.2 on seeds 1, 2 and 3.

<!-- /lab:data-table -->

**Verdict at the preregistered bar: **fail**.** The hybrid cell,
named in advance as the one the verdict reads from, came in at
65.1 percent. Its vector sibling did better at 68.6 percent, still
well short of 90.

## Hermes's own search is a 30-sided die

Hermes FTS5 as typed scored 17.2 percent at five. Chance is 16.7.
That is not a coincidence: when the `AND` of every word in the
question finds nothing, Hermes retries with `OR`, and the question's
"the" and "and" then match every session. The agent gets ten
sessions back ranked by how many stopwords they contain. Joining only
the content words with `OR` scores 1.4 percent, below chance,
because now most questions match nothing at all.

This confirms the objection from the research note, and it is the
expected result for an index that matches strings. It is also the
reason this report exists.

## The plugin finds two in three

With `bge-m3` behind it, Hermes found the right day in the top five
for 68.6 percent of questions in vector mode. When it found the day
it mostly found it first: in seed 1, 109 of 240 questions had the gold
row at rank one. When it missed, it mostly missed entirely: 57 of 240
had no row from the right day anywhere in the top ten. The miss lists
in [summary.md][summary] name every question missed in all three
seeds; 28 of them in vector mode. They are not a vocabulary cluster.
"The beeping detector on the steps and what I did about it" missed.
"Who is coming to clear the fireplace vent" missed. "The recurring
chat with my boss about promotion" missed.

[summary]: https://github.com/saxby-tools/lab/blob/HEAD/reports/002-memory-recall/recall/results/summary/summary.md

Two things about the setup make this harder than a benchmark of
sentence pairs, and both are what a real agent would face:

- **The fact is buried.** Each stored row is a paragraph of about 40
  words: one fact and three to five filler sentences. The embedding
  of "porridge again, caught the 8:10 bus, the plumber swapped the
  cartridge, stretched before bed" is a blend, and the question is
  about one ingredient of it.
- **Acknowledgements take up slots.** The plugin stores the
  assistant's turns too. Here those were "Noted" and "Got it," and
  they filled 21.0 percent of the top-five slots in vector mode.
  Dropping them after the fact changes recall by less than a point,
  because the questions it missed were not in the top ten anyway.

Hybrid mode scored 65.1 percent, below vector. The plugin's own
README reports the same ordering on a published benchmark, which is
why vector is its default.

What this cell did not test is the plugin's full path. By default it
also asks a model to extract durable facts at the end of each
session, and recall searches those facts first. That is the plugin
behaving as designed, and it is the obvious next round: a question
against "the plumber replaced the kitchen faucet cartridge" should do
better than against the paragraph it was buried in. It was left out
here because it adds a model call whose output changes between runs,
and because the preregistered question was whether embeddings find
paraphrases. Round 3, below, ran it.

## OpenClaw scored at chance, and its control explains why

This was the surprise, and it needs its control explained first. Each
setup was asked every fact's own sentence, word for word. Hermes FTS5
and the LanceDB plugin returned the right day first every time.
OpenClaw's hybrid search, asked for "The plumber swapped the cartridge
in the kitchen faucet, and the drip that kept me up at night is
finally gone," put that day in its top five 55.8 percent of the
time.

The arithmetic is in the raw scores. OpenClaw ranks each chunk by
relevance times a recency decay with a 30-day half-life. The chunk
holding that sentence scored 0.978 on keywords and 0.522 on vectors,
and 0.332 after the decay for a note 29 days old. A filler chunk from
11 days later, with no plumber in it, scored 0.823 on keywords
because it shares "the," "and," "up" and "night," 0.498 on vectors,
and 0.491 after a milder decay. It ranked first. Two defaults do
this together:

- **`bge-m3`'s cosine scores sit close together.** Unrelated chunks
  score around 0.45 against a query; the chunk that contains the
  query's exact words scores 0.52. With the vector leg weighted
  highest, that gap is smaller than the decay between two weeks.
- **The decay is not a setting.** Dated `YYYY-MM-DD.md` files under
  `memory/` decay; the agent's daily notes are exactly those files.

On the paraphrased questions, OpenClaw hybrid scored 4.3 percent
and keyword-only 3.9. About a quarter of the questions returned nothing
at all, cut by the default minimum score of 0.35, which is calibrated
for OpenAI's embeddings. Removing the cut after the fact, cell C3,
scored 15.3 percent: with every chunk's relevance about equal, the
newest notes win regardless of the question, and the top result was
one of the last few days almost every time.

To separate the decay from the retrieval, the same notes went in
again as `entry-01.md` to `entry-30.md`, which OpenClaw treats as
evergreen. That is cell C4, also post hoc. Its exact-sentence control
came back at 99.7 percent, and the paraphrased questions at
16.2. With the decay gone OpenClaw finds the exact words all but
once in 360 tries and the paraphrase no better than a guess. Its embedding leg
adds almost nothing over keywords here: its chunks run to five
paragraphs, and `bge-m3` scores a 250-word chunk about the same
against a question whether or not the answer is in it. The LanceDB
plugin, with the same embedder over single paragraphs, found two in
three.

None of this is a bug in the harness; the index reported 30 files,
120 chunks, vectors ready, and the one hand-traced search matched the
scoring rules in OpenClaw's own documentation. It is what OpenClaw's
built-in memory search does with this embedder over a dated diary.
The hypothesis that the two harnesses would land within ten points of
each other was wrong in both directions.

## Round 3: the plugin's own path, extraction on

Added after publication, preregistered as round 3 and run overnight.
The B cells above fed the plugin raw turns with its fact extraction
off. This round turns it on: for each of the 30 sessions, the
plugin's own `extract()` asks the chat model, `gemma4:31b-128k`
through Saxby, for durable facts, stores them as fact rows beside the
turns, and recall searches the facts first, the way the plugin runs
by default.

**As shipped, it extracted nothing.** On this Hermes, v0.22.5, the
plugin's extraction call passes a `response_format` argument that
Hermes's auxiliary client does not accept. The plugin catches the
error, logs it at debug level and returns no facts, so all 90
sessions came back empty within two seconds each, and the fact cells
scored zero: B3 and B4 at 0.0, and B5, facts and turns together,
exactly B1 again. Someone who installed this plugin on this Hermes,
left the defaults alone and asked "that time we talked about X" would
get the two-in-three memory from the sections above, and nothing in
the logs to say why. It has not been reported upstream yet.

So the round ran a second time with a shim: a short patch that moves
the argument into the client's `extra_body`, unwraps the reply object
the client now returns, and gives a local 31B model 300 seconds
instead of 30. The prompt, the parsing and the storage stay the
plugin's. The shim is in `hermes-lancedb-facts.py` in the data
folder, and the facts it produced are committed beside the results.

<!-- lab:data-table -->

| Cell | Setup | at 1 | at 5 | at 10 |
| --- | --- | --- | --- | --- |
| B1 | Turns only, vector (round 1) | 47.1 | 68.6 | 75.4 |
| B3 | Extracted facts, vector, as shipped | 0.0 | 0.0 | 0.0 |
| B6 | Extracted facts, vector, shim | 70.4 | 89.4 | 92.2 |
| B7 | Extracted facts, hybrid, shim | 40.1 | 84.3 | 91.5 |
| B8 | Facts and turns, vector, shim | 72.9 | 90.1 | 93.8 |

Recall at k, mean of three seeds, percent. B6's seeds: 90.0, 92.1,
86.2.

<!-- /lab:data-table -->

**With the shim, the plugin's own path lands on the bar.** Searching
the extracted facts in the plugin's default vector mode found the
right day in the top five for 89.4 percent of questions, 20.8 points
above the turn rows; H5 asked for ten. Facts and turns together came
in at 90.1. Hybrid trailed again, at 84.3. The gain is not a
reshuffle: of the 720 question-and-seed pairs, 188 went from miss to
hit and 38 the other way. When it hit, it mostly hit first, 70.4
percent at rank one against 47.1 for the turns. And where facts and
turns competed, the facts won: in B8 the first hit was a fact row 551
times out of 649.

The facts themselves are what you would hope for. The model turned
each session's twenty paragraphs into seven or eight one-line facts,
686 in all, such as "The user considers beans on toast to be a
reliable fallback meal." Most of the filler was dropped; some of it
survived as habits. A question about one ingredient of a paragraph
is now a question about a sentence that holds only that ingredient.
It cost about 100 seconds of model time per session on an M5 Max,
once, at session end; one session in 90 came back with no facts at
all.

**Verdict on round 3, at the bar it preregistered.** As shipped, the
plugin's own path scores zero: a fail, and a bug report. With the
shim, B6 at 89.4 is above 70 and below 90, which the decision rule
calls inconclusive, half a point short of a go. B8 clears 90 but is
not the cell the rule named, and the three-seed interval on B6 runs
82 to 97. The plain reading: with extraction working, this is the
memory I asked for, give or take a question in twenty, and the 11
questions missed in every seed are the same stubborn ones as before:
the beeping detector, the fireplace vent, the compost bin.

One correction in the data. Seed 1's first session was extracted
while six containers left over from a bad launch shared the model;
it timed out after 15 minutes and got no facts. It was extracted
again on its own, and seed 1's three shim cells were rerun from the
saved facts. `data.md` has the numbers before and after; the means
moved by about a point.

## Round 4: OpenClaw without the cut, undated

Added after publication, preregistered as round 4 and run the same
night. The missing cell was undated notes with the score cut removed:
C5, OpenClaw's bge-m3 hybrid with `--min-score 0` over the C4 indexes.

<!-- lab:data-table -->

| Setup | Score cut | Recall at 5 | Recall at 10 |
| --- | --- | --- | --- |
| Dated notes (C2) | 0.35 | 4.3 | 4.7 |
| Dated notes, no cut (C3) | none | 15.3 | 21.1 |
| Undated notes (C4) | 0.35 | 16.2 | 24.3 |
| Undated notes, no cut (C5) | none | 38.8 | 60.0 |

Mean of three seeds, percent. C5's seeds: 39.6, 38.8, 37.9.

<!-- /lab:data-table -->

H6 said C5 would stay within ten points of chance. It did not: with
both defaults out of the way, OpenClaw finds the right day in its top
five for 38.8 percent of paraphrased questions and in its top ten for
60. So the cut does cost real recall once the decay is gone, about 22
points at five, and the issue's premise half stands. The other half
is the gap that remains: 38.8 against the LanceDB plugin's 68.6 with
the same embedder, which is where chunk size (400 tokens with 80
overlap, not a setting) and the keyword leg's weight live. Neither is
reachable from the config, so that is where this round stops.

For Aster today, the practical reading is the earlier one: dated daily
notes plus the 30-day decay put OpenClaw's recall at chance regardless
of the cut, and only undated files or a changed ranking would move it.

## Personality did not move

The second half of the question was whether a `/personality` preset
makes the agent feel warmer, enough to paper over shallow memory.
Hermes ships 14 presets as session overlays on the user's `SOUL.md`.
I ran five of them and a control, two samples each, from the same
cold start: a three-sentence `SOUL.md`, empty memory, the same model
through Saxby, and one line, "hey, I'm home. Long day."

The replies are in [personality/replies][replies]. Four of the six
conditions produced the same sentence, "Welcome back. Hope you can
relax now." The control did. `surfer` did. `hype`, whose prompt reads
"YOOO LET'S GOOOO," did on one of its two tries and added "Sorry to
hear it was a long one" on the other. Only `teacher` and `kawaii`
clearly differed, and `kawaii` differed by adding kaomoji. A
three-sentence `SOUL.md` that says "be direct and plain" outweighed
every overlay on this model.

[replies]: https://github.com/saxby-tools/lab/tree/HEAD/reports/002-memory-recall/personality/replies

The blind rating came in after publication, before the key was
opened: warmth of the reply as it reads, 1 to 5, and a second number,
whether Niko would want it from his own agent. Means of two samples:

<!-- lab:data-table -->

| Condition | Warmth | Preference | Warmth minus control |
| --- | --- | --- | --- |
| none | 4.00 | 4.00 | +0.00 |
| helpful | 4.75 | 5.00 | +0.75 |
| teacher | 5.00 | 4.50 | +1.00 |
| surfer | 4.12 | 4.12 | +0.12 |
| hype | 4.50 | 4.25 | +0.50 |
| kawaii | 5.00 | 1.00 | +1.00 |

Two samples per condition, one rater, one opening line. H4 asked for a
preset one point or more warmer than the control; `teacher` and
`kawaii` reached exactly that. The same text got 4.5 once and 5 once,
so half a point here is rater noise. [ratings.md][ratings] has every
score and the key.

<!-- /lab:data-table -->

The preference column is the useful one. `kawaii` was rated as warm as
anything and scored 1 for wanting it: "I'm in my 40s, I'm not doing
emoji talk." The replies that won on preference did one thing the
control did not: they used Mara's name. In Niko's words, being
addressed by name is the warmest thing a reply can do, and the shorter
the better. So the personality that helped was not a preset at all; it
was a name and a sentence, which `SOUL.md` could carry on its own.

[packet]: https://github.com/saxby-tools/lab/blob/HEAD/reports/002-memory-recall/personality/packet.md
[ratings]: https://github.com/saxby-tools/lab/blob/HEAD/reports/002-memory-recall/personality/ratings.md

## What this does and does not show

- **It is one corpus,** invented, in one register, with filler that
  outweighs facts five to one. A diary written by a real person has
  more varied text and fewer facts per day. The ranking between setups
  should hold; the absolute numbers are this corpus's.
- **It is one embedder,** `bge-m3`, one quantisation, one size. A
  different embedder changes every cell except the FTS5 ones.
- **Extraction is a model's output.** The B1 and B2 numbers are the
  plugin with its extraction off, a floor. Round 3's facts came from
  one model, sampled once per seed; a different model, or the same one
  on another day, extracts different facts, and B6 to B8 move with
  them. The as-shipped zeros do not.
- **OpenClaw at its defaults.** A `minScore` tuned for `bge-m3` is a
  one-line change; the recency decay is not a setting. Neither was
  tuned here, because tuning after seeing the data is how a number
  stops meaning anything.
- **Items, not days.** Recall counts the first five items as the tool
  returns them. For LanceDB that can be five rows from two days; for
  OpenClaw two chunks of one day. Collapsing repeats moves the LanceDB
  cells by about a point.
- **No agent in the loop.** This measures what the search hands the
  model, not whether the model then answers well. An agent that reads
  ten results and reasons may recover some of the misses at rank six
  to ten, and may be misled by the acknowledgements.
- **Three seeds** vary the diary's layout, not the questions, so the
  interval speaks to layout, not to a different set of questions.
- **The dates.** Notes sit within the 46 days before the run, so
  OpenClaw's recency decay spans a factor of about three across the
  diary. Older notes would make its ranking worse, not better.

## What I take from it

The objection was right, and the plugin answers it in two steps. Fed
raw turns, a local Hermes with LanceDB and `bge-m3` turns "that time
we talked about X" from a coin toss into two hits in three. Fed its
own extracted facts, which is how it is meant to run, it reaches nine
in ten, with the right day first for seven in ten. The catch is that
on this Hermes it does not run that way out of the box: extraction
fails silently, and the user gets the two-in-three memory with no
sign anything is wrong. That is a bug report, not a design flaw.
OpenClaw's built-in search stays at chance with dated notes, and
reaches 39 percent with its decay and its cut both out of the way.
Personality is not a substitute: on this
model the presets barely changed a word, and the one change that was
wanted, using my name, needs no preset.

<!-- lab:footer -->

Saxby · From the lab · Report No. 002 · Oct. 2026

Data: the corpus, every ranked result and the scripts that rebuild
the tables are in [saxby-tools/lab][lab]; `npm test` there checks
every number on this page against them. Harness and write-up by
Claude Code; the personality ratings are Niko's own.

[lab]: https://github.com/saxby-tools/lab/tree/HEAD/reports/002-memory-recall/

<!-- /lab:footer -->
