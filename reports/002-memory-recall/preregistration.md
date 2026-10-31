#  Preregistration: the memory recall test

What was decided before any run, with the time each rule was written.
The time is the commit that added it to this file; the first result
commit comes after. Treat the times as a record, not as proof.

##  Research question

Niko's words: does a local Hermes memory plugin, embedding with his own
`bge-m3`, answer paraphrased "that time we talked about X" questions
over an agent's past, and can a friendlier personality make up for
shallow memory?

##  Hypotheses

Written before the corpus was generated and before any index was built.

- **H1.** Hermes Agent's default `session_search` (SQLite FTS5,
  `unicode61`, no stemming, no vectors) will recall the gold note in
  its top five for fewer than half of the paraphrased queries.
- **H2.** Hermes with the LanceDB memory plugin embedding through
  `bge-m3` will recall the gold note in its top five for at least 90
  percent of the paraphrased queries.
- **H3.** OpenClaw's built-in hybrid search with `bge-m3` will land
  within 10 points of Hermes plus LanceDB, and OpenClaw's keyword-only
  mode within 10 points of Hermes FTS5. The harnesses differ in
  engine, not in what retrieval can do.
- **H4.** In the blind warmth rating, at least one `/personality`
  preset will average one point or more above the control.

##  Decision rule

Niko's bar: on ten paraphrased questions, zero or one miss is a go,
three or more misses is a fail. Applied to the full query set:

| Mean recall at 5, Hermes plus LanceDB | Verdict |
| --- | --- |
| 90 percent or higher | Go: the plugin answers the objection. |
| Above 70 and below 90 percent | Inconclusive: two misses in ten. |
| 70 percent or lower | Fail: shallow memory is real. |

The verdict is read from the mean over the three runs of the
hybrid-mode cell (B2 below). The interval is reported beside it. The
personality arm informs the second half of the question and does not
move the verdict.

##  Metric

**Primary.** Recall at 5: a query succeeds when the note holding its
gold fact is among the first five items the harness returns, counted
as the harness returns them: sessions for Hermes FTS5, rows for
LanceDB, chunks for OpenClaw. Five is what a prefetch or a tool call
shows an agent.

**Secondary,** reported, not judged: recall at 1 and at 10; recall at
5 after collapsing repeated items from one note; and per-query miss
lists.

**No model judges anything** in the recall arms. Scoring is a string
comparison between a returned item's note id and the gold note id.

##  Design: two harnesses, two search modes

| Cell | Harness | Mode |
| --- | --- | --- |
| A1 | Hermes Agent | `session_search`, FTS5, query as typed (terms ANDed) |
| A2 | Hermes Agent | `session_search`, FTS5, content words joined with OR |
| B1 | Hermes Agent | LanceDB plugin, `bge-m3`, vector mode (plugin default) |
| B2 | Hermes Agent | LanceDB plugin, `bge-m3`, hybrid mode, RRF fusion |
| C1 | OpenClaw | `memory_search`, `provider: none`, keyword only |
| C2 | OpenClaw | `memory_search`, `provider: ollama`, `bge-m3`, hybrid |

A2 exists because the tool's own no-match message tells the agent to
"broaden with OR". A1 is what a naive call does. Both are reported; A2
is the one H1 is judged on, since it is the kinder reading.

B1 and B2 index the corpus as raw turns (`kind: turn`), with the
plugin's LLM fact extraction turned off, so that the three harness
cells index the same words. Extraction is the plugin's default and a
real agent would have it on; it is left out here because it adds a
model call whose output varies between runs, and because the question
is whether embeddings find paraphrases, not whether a model
summarises well. If time allows, an exploratory cell with extraction
on is run after the preregistered cells and labelled as such.

LanceDB over the Qdrant plugin: Apache-2.0, stores raw turns as well
as facts, offers hybrid search, and takes any OpenAI-compatible
embeddings endpoint, so `bge-m3` through Ollama's `/v1/embeddings`
needs no code. The Qdrant plugin is dense-only and extracts facts with
a model on every write.

##  Corpus

Generated, seeded, committed. Never Aster's files.

- A fictional user over about six weeks of dated daily notes, each
  built from atomic facts with gold ids, padded with mundane filler
  from fixed pools. About 150 KB in all.
- Each fact carries two or three held-out queries written with
  vocabulary the note does not use. A check script rejects any query
  that shares a content word with its gold note or with any filler
  pool, comparing crude stems so that "leak" also blocks "leaking".
  The committed corpus passes that check.
- Notes are dated within the 46 days before the run, because
  OpenClaw's ranking decays dated notes with a 30-day half-life. Every
  harness sees the same dates.
- Hermes sees each note as one past session: each paragraph is a user
  message, each answered by a short, content-free acknowledgement.
  OpenClaw sees the same note as `memory/YYYY-MM-DD.md`. LanceDB sees
  each user paragraph as one turn row.

##  Runs

Three runs per cell, seeds 1, 2 and 3. A seed changes which facts land
in which note, the note dates, and the filler. Every query runs in
every run. Each run rebuilds every index from an empty store.

Reported per cell: mean recall at 5 over the three runs with a 95
percent t-interval over run means, the pooled per-query rate with a
Wilson interval, and the list of queries missed in every run.

##  Personality arm

Hermes `/personality` presets layered on one fixed `SOUL.md`, model
and settings held constant, memory files empty. Five presets and a
control, each asked the same opening line from a cold start, two
samples each. The twelve replies are shuffled and stripped of labels;
Niko rates each from 1 to 5 for warmth without seeing the key. The
report gives per-condition means with the small-n caveat. No language
model rates anything in this arm.

##  Versions pinned

Every version is recorded in `data.md` before the first result commit:
Hermes image digest, OpenClaw version, Ollama version, `bge-m3`
digest, the chat model tag, the LanceDB plugin commit, LanceDB and
OpenAI SDK versions in the container, and the Saxby commit.

##  What report 1 skipped, and what this one does about it

| Prerequisite | Report 1 | Report 2 |
| --- | --- | --- |
| Hypotheses written first | Round 1 had none | H1 to H4 above |
| Decision rule written first | Round 1 had none; round 2 did | Table above |
| Metric defined first | Lived in the grader, redated later | Recall at 5, defined here |
| Controls | Gemma as control in round 2 only | A1/A2 against B1/B2; C1 against C2 |
| Repeated runs | Three per task, one seed | Three seeds, every index rebuilt |
| Confidence intervals | None | t and Wilson intervals |
| Pinned versions | Model digests not recorded (issue 1) | Digests and commits in `data.md` |
| Scripts and data committed | Yes | Yes, with a corpus check |
| Limitations stated | Partly, in Corrections | Its own section in the report |

##  Decided after the plan

Written as the runs went, dated by their commits. None of it changes
the verdict cell or the bar.

- **Exact-text controls (A0, B0, C0).** Added after the first seed-1
  smoke run and before the full runs: each fact's own sentence as the
  query, one per fact. A validity check that each index finds the
  text it holds, not a hypothesis test.
- **Hermes retries with OR on its own.** Found in Hermes's search code
  after the plan was written: when the `AND` of a multi-word query
  finds nothing, `search_messages` retries the terms joined with
  `OR`, stopwords included. Cell A1 is therefore "as typed, with
  Hermes's own retry", not pure `AND`. A2 stays as planned.
- **C3, OpenClaw without the score cut.** Added after C2's first rows
  showed most paraphrases returning nothing. The same index and
  queries with `--min-score 0`. Post hoc; reported, not judged.
- **C4, OpenClaw with undated notes.** Added after the first C0
  control rows came back at a fifth (56 percent once complete): a
  verbatim sentence from four weeks earlier lost to recent filler. The same notes copied in as `entry-NN.md`,
  which OpenClaw treats as evergreen, so its 30-day recency decay does
  not apply, with its own exact-text control. Post hoc; reported, not
  judged.
- **Acknowledgement rows, B cells.** A post hoc rescoring of the same
  ranked lists with the assistant's acknowledgement rows removed, to
  see whether storing them cost recall.
