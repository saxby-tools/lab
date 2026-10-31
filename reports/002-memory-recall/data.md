#  Data: the memory recall test

What every file holds, how it was collected, what was checked, and
every change made since it was recorded.

##  At a glance

| Arm | Runs | Folder |
| --- | --- | --- |
| Recall, six cells plus three controls | 3 seeds, 240 queries each | `recall/results/seed-N/` |
| Personality, six conditions | 2 samples each | `personality/replies/` |

Everything ran on one machine: an Apple M5 Max with 128 GiB of unified
memory, macOS 26, Docker Desktop 4.97.0 (engine 29.9.2, linux/arm64
VM), Ollama 0.40.13 with Saxby's patches, on Oct. 30, 2026.

##  Versions

Pinned before the first result commit.

| Piece | Version |
| --- | --- |
| Hermes Agent image | `nousresearch/hermes-agent:v0.22.5`, digest `sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d`, reports itself as v0.22.5 (2026.9.24), upstream `bf0203a7` |
| Python inside the image | 3.14.9, SQLite 3.53.1 |
| LanceDB memory plugin | `lancedb/hermes-agent-memory` commit `6691591e62e10438ee32ff671afad337208fdd43` (June 15, 2026), plugin version 0.1.0, Apache-2.0 |
| Plugin dependencies | lancedb 0.41.0, openai 3.41.0, pyarrow 26.0.0, pyyaml 6.0.3 |
| OpenClaw | 2026.10.9 (`8b18b55`), the Homebrew install on the host |
| Ollama | 0.40.13+saxby.ad4b55d8 (ollama-saxby build) |
| Embedder | `bge-m3:latest`, Ollama digest `790764642607`, 566.7M parameters, 1,024 dimensions, F16 |
| Chat model, personality arm only | `gemma4:31b-128k`, Ollama digest `d0e8710a4e62`, 31.3B, Q4_K_M, routed as a raw model name through Saxby |
| Saxby | 0.9.7, commit `44038ca6fd0b4b4682db53cd71383a15beec59c7` (v0.9.7-7-g44038ca) |
| Docker | Desktop 4.97.0, engine 29.9.2 |
| Host Python for `generate.py`, `check.py`, `openclaw.py`, `score.py` | 3.15.2 |

##  Corpus

`recall/facts.json` holds 120 invented facts about a fictional person,
each with two held-out queries. `recall/filler.json` holds the mundane
sentences padded around them. `recall/generate.py --seed N` builds
`recall/corpus/seed-N/`:

- `notes/YYYY-MM-DD.md`: 30 dated notes, each four facts and 14 to 17
  filler paragraphs, about 140 KB per seed. OpenClaw indexes these
  files as `memory/*.md`.
- `sessions.json`: the same notes as paragraphs, each with a short
  content-free acknowledgement. Hermes sees each note as one past
  session, user paragraph then assistant acknowledgement, 20 or so
  turns per note.
- `queries.json`: the 240 queries with their gold note id.
- `manifest.json`: counts, sizes and SHA-256 digests.

`recall/check.py` compares crude stems and refuses any query that
shares a content word with its gold fact, with any filler sentence, or
with the whole gold note. The generator swaps facts between notes
until no query shares a stem with another fact in the same note. All
three committed corpora pass with zero collisions.

Notes are dated between Sept. 14 and Oct. 29, 2026, the 46 days before
the run, because OpenClaw's ranking decays dated notes with a 30-day
half-life.

##  How recall was measured

Every cell ran the same 240 queries against a fresh index built from
the seed's corpus. `recall/results/seed-N/<cell>.jsonl` has one line
per query: the query, what was actually sent (`sent`), the items
returned in order (`ranked`, as note ids), and the time taken.

- **A0, A1, A2:** `recall/hermes-fts.py`, inside the Hermes container
  with the image's own Python, builds `state.db` through Hermes's
  `SessionDB` and calls Hermes's `session_search` tool function with
  `limit=10`. A1 sends the query as typed. A2 sends its content words
  joined with `OR`. A0 sends each fact's own sentence. Hermes's search
  code retries a multi-word query as `OR` on its own when the `AND`
  form returns nothing; that retry includes the stopwords, which A2
  strips. Items are sessions, deduplicated by Hermes.
- **B0, B1, B2:** `recall/hermes-lancedb.py`, same container, loads
  the plugin as the package its own entry point builds, writes the
  plugin's config block into `config.yaml` (bge-m3 through Ollama's
  `/v1/embeddings` on the host, `search_kinds: [turn]`, extraction
  off), stores every user paragraph and every acknowledgement as a
  `turn` row the way `sync_turn` does, and calls the plugin's
  `recall()` with `kind="turn"`, `limit=10`, RRF fusion. B1 is vector
  mode, the plugin default; B2 is hybrid; B0 is vector mode with each
  fact's own sentence. Items are rows.
- **C0 to C4:** `recall/openclaw.py` on the host, with
  `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` pointing into a
  throwaway folder and no gateway started, copies the notes into a
  workspace, runs `openclaw memory index --force`, then
  `openclaw memory search --json --max-results 10` per query. C1 is
  `provider: "none"`, C2 is `provider: "ollama"` with `bge-m3`, C0 is
  C2's index with each fact's own sentence. C3 is C2's index searched
  with `--min-score 0`. C4 is a second index of the same notes copied
  in as `entry-NN.md` so OpenClaw's recency decay does not apply, with
  `C4-control` its exact-text check; `mapping.json` in the work folder
  maps the file names back to note ids. Items are chunks; a note can
  appear more than once. `C1-status.json`, `C2-status.json` and
  `C4-status.json` record `memory status --deep` after indexing: 30
  files, about 120 chunks, embeddings ready, vector store ready.

`recall/score.py` writes `recall/results/summary/summary.json` and
`summary.md`.

##  Record fields

| Field | Meaning |
| --- | --- |
| `cell`, `qid`, `note_id` | The cell, the query id (`F012-q2`, or `F012-exact` for a control) and the gold note |
| `text` | The query as written in `facts.json` |
| `sent` | What the harness was given: the same text, or the `OR` form in A2 |
| `ranked` | Note ids of the returned items, first to last, up to ten |
| `roles` | B cells only: the role of each returned row, `user` or `assistant` |
| `scores` | C cells only: OpenClaw's final score per chunk, after its recency decay |
| `sessions_searched` | A cells only: distinct sessions Hermes returned |
| `stale` | C cells only: OpenClaw's warning that the index was incomplete; never set |
| `elapsed_ms` | Wall time of the one search call; for C cells that includes starting the CLI |

##  How the personality replies were collected

`personality/run.py` builds a fresh Hermes home per sample from
`personality/config.yaml` (model `gemma4:31b-128k` through Saxby,
`display.personality` set to the condition) and `personality/SOUL.md`
(fixed, three sentences), with empty memory files, then runs
`hermes chat -q "hey, I'm home. Long day."` in the pinned container.
The reply is cut from the CLI's text output between the `☤ Hermes`
line and the next rule. `replies/<name>.txt` holds each reply,
`replies/<name>.log` the whole output including the model's thinking,
and `replies.json` the set. `personality/packet.py` shuffles them into
`packet.md` with the key kept outside the repository until the ratings
are in.

##  What was checked

- `recall/check.py` on the fact bank, the filler and all three
  corpora: zero collisions.
- The exact-text controls: A0 and B0 scored 100 percent on every
  seed. C0 did not; OpenClaw's ranking multiplies relevance by a
  recency decay, so with dated notes even the verbatim sentence lost
  to recent chunks. C4-control, the same check on undated copies of
  the notes, is the control the OpenClaw hybrid numbers should be read
  against. The report quotes all of them.
- One OpenClaw search was traced by hand to confirm the arithmetic:
  the chunk holding the queried sentence scored 0.978 on text and
  0.522 on vector, and 0.332 after the decay for a 29-day-old note; a
  filler chunk 11 days old with 0.823 and 0.498 scored 0.491 and
  ranked first.
- OpenClaw's `stale` flag was never set on any search.
- The real OpenClaw config at `~/.openclaw/openclaw.json` was not
  modified during the runs (its modification time predates them).

##  Known limits of the setup

- Hermes's `state.db` sat on a Docker bind mount, so Hermes switched
  it to `journal_mode=DELETE` and said so. Search results do not depend
  on the journal mode.
- The Hermes image's own `uv` refuses packages newer than its build
  date; `run.sh setup` lifts that cutoff to install the pinned plugin
  dependencies.
- OpenClaw's CLI starts a Node process per search, so its `elapsed_ms`
  is dominated by startup and says nothing about the engine.

##  Changes since recording

- **Oct. 30, 2026, during the runs:** the first seed-1 OpenClaw cells
  were collected by a version of `openclaw.py` that buffered its
  output until the end; the rows are the same, written at once. C3,
  C4 and the `--only-control` path were added to the script while
  seeds 2 and 3 ran. The Hermes cells for seed 1 were rerun once after
  the controls were added, replacing the smoke-test files.
