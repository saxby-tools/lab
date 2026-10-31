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
almost half the time.

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
paraphrases.

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

The blind rating still stands. The twelve replies are shuffled and
unlabelled in [packet.md][packet], and the key is held outside the
repository. The ratings were not in when this was published;
[ratings.md][ratings] fills in when they are, with per-condition means
and the caveat that two samples per condition, one rater and one
opening line can show a difference but cannot measure it.

[packet]: https://github.com/saxby-tools/lab/blob/HEAD/reports/002-memory-recall/personality/packet.md
[ratings]: https://github.com/saxby-tools/lab/blob/HEAD/reports/002-memory-recall/personality/ratings.md

## What this does and does not show

- **It is one corpus,** invented, in one register, with filler that
  outweighs facts five to one. A diary written by a real person has
  more varied text and fewer facts per day. The ranking between setups
  should hold; the absolute numbers are this corpus's.
- **It is one embedder,** `bge-m3`, one quantisation, one size. A
  different embedder changes every cell except the FTS5 ones.
- **Raw turns, no extraction.** The LanceDB numbers are for the plugin
  with its model-based extraction off. That is a floor for the plugin,
  not its default behaviour.
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

The objection was right, and the plugin half-answers it. A local
Hermes with LanceDB and `bge-m3` turns "that time we talked about X"
from a coin toss into two hits in three, with the right day usually
first when it hits. That is a real memory and not the one I asked for.
The honest next step is the plugin's own path, extraction on, under a
new preregistration, and a second look at OpenClaw with a score cut
that fits its embedder. Personality is not a substitute: on this
model, the presets barely changed a word.

<!-- lab:footer -->

Saxby · From the lab · Report No. 002 · Oct. 2026

Data: the corpus, every ranked result and the scripts that rebuild
the tables are in [saxby-tools/lab][lab]; `npm test` there checks
every number on this page against them. Harness and write-up by
Claude Code; the personality ratings are Niko's own.

[lab]: https://github.com/saxby-tools/lab/tree/HEAD/reports/002-memory-recall/

<!-- /lab:footer -->
