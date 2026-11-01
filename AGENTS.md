#  Saxby lab

The tests, harnesses and raw results behind the Saxby lab reports, and
the Eleventy site that publishes them at
<https://saxby-tools.github.io/lab/>. [Saxby](https://github.com/saxby-tools/saxby)
is a local-first router for language models; the lab is where its
model choices get tested against evidence instead of intuition.

The README is the site's front page, written for readers. This file is
for whoever does the work: how a report comes to be, the rules it
follows, and the decisions already made with their reasons. Everything
above "Working on the maintainer's machine" holds for any checkout.

##  Layout

```
README.md                  the front page; lists every report
AGENTS.md                  this file
reports/NNN-slug/          one folder per report, numbered in order
  index.md                 the report, in Markdown; the site builds it
  README.md                results table, what's here, how to rerun,
                           corrections, known gaps
  data.md                  versions, methods, record fields, what was
                           checked, and every change since recording
  preregistration.md       the rules set before any run, dated
  checks/*.test.js         every number on the pages, checked against
                           the data
  <harness>/               scripts, inputs and results, as they ran
  *.11tydata.json          the site's settings for that report
site/                      layouts, components, styles; see
                           site/README.md
.scratch/report-NNNN/      throwaway homes, logs, keys; never built,
                           never committed
```

Code is AGPL-3.0-or-later; reports, docs and recorded data are
CC BY-SA 4.0. `LICENSE-DATA` says exactly which files that covers.
Every script carries a one-line licence note.

##  How a report happens

**Is it worth a report?** A report earns its number when all of these
hold. If one does not, it is a note, a probe or an issue, not a report.

- It informs a decision someone is about to make: which model gets a
  job, whether a harness is good enough to move to.
- It asks one question that an objective score can answer: hidden
  tests, a string match on a gold answer, a count. No model grades
  anything; where a human judges, the packet is blind and the key is
  kept outside the repo until the ratings are in.
- A pass bar can be written down before the first run, in the asker's
  own words, and the verdict read from one named cell.
- It runs on owned hardware in about a night, with versions that can
  be pinned, and someone else can rerun it from this repo.
- The things it compares see the same inputs. Report 002 fed every
  setup the same corpus and the same 240 queries.

**Preregister first.** `preregistration.md` is committed before the
first run and says when it was written. It holds the research
question, hypotheses, the decision rule, the metric, the design, the
corpus, the runs, and the versions pinned. Anything decided after that
commit goes under a "Decided after the plan" heading, dated. A
follow-up round gets its own dated section there, a lab issue, and its
own cells; it never edits the verdict the first round read.

**Run it so it can be checked.** Each cell builds its index or
environment from empty. Every record names what answered it: model
tag, model digest, server version. Every setup also gets a control
that must score 100, such as asking for the exact text it stored;
when a control fails, that failure explains more than the cell does,
so report it. Three seeds or runs, with the seed-to-seed spread
quoted. Isolate harnesses in containers or throwaway homes under
`.scratch/report-NNNN/`, never in a real install.

**Write it in four files.** `index.md` opens with the label, a deck
that states the answer, a chart and the table, then why, how, what the
numbers say, the limits, and what the author takes from it. `README.md`
has the results table, the folder tree, the rerun steps, a Corrections
section and the known gaps. `data.md` has the versions, how each cell
was measured, the record fields, what was checked, the setup's known
limits and a dated "Changes since recording" list. `checks/*.test.js`
reads every number the pages quote from the scorer's summary and
fails on any that differs.

**Publish.** `npm test`, `npm run build`, commit per file group, push
to `main`, tag the report `report-NNN`, add it to the README's report
table. Every gap found and not fixed becomes an issue labelled
`known-gap`; a follow-up round becomes an issue too. Nothing stays as
a TODO in a file.

**Afterwards, nothing changes silently.** A fix after publication goes
in that report's Corrections with a date, and in `data.md`'s change
list. A retitle gets the same. The folder name and the address never
change.

##  Commands

```bash
npm ci                 # exact versions; scripts are not run on install
npm test               # site tests and every report's checks
npm run build          # Eleventy, into _site/
npm run serve          # the site with reload
```

Each report's harness has its own rerun steps in its README, usually a
`run.sh` with one target per stage. Reruns overwrite the results
folder on purpose: the committed files are the record, and git shows
what moved.

##  Writing

- Markdown first. Every page must read plainly on GitHub, so no front
  matter: a page's layout, address and title come from
  `eleventy.config.js` and the `*.11tydata.json` files. Site features
  go in `<!-- lab:name {...} -->` comment blocks, which GitHub hides.
  `site/README.md` lists the blocks.
- AP style, a 9th-grade reading level, 80 columns in prose and code.
  Numbers go in tables, not sentences, and a table whose first column
  is a cell id is checked by the tests. Use a plain label in the first
  column only for a table the checks should not read.
- The red-box label: `word` is one short word, never "test", kept
  lighthearted. The heading inside the block can say more. **Every
  label title needs Niko's approval before it ships.**
- A report says what it does not show, in its own section, before it
  says what the author takes from it.
- Dates are local time, AP style: "Oct. 30, 2026". A run that crosses
  midnight says so.

##  Code

- Hard 80 columns. Constants at the top. Functions in call order, none
  called before it is defined. One condition per line. Filenames use
  dots or hyphens, never underscores.
- Host scripts are Python 3 standard library or Node 20 with the dev
  dependencies in `package.json`, pinned exact. A harness that needs
  more runs in a container with the versions written in its README.
- Tests sit in `checks/` and run with `node --test`; they need no
  daemon, no model and no network.
- Conventional commits with the report number or `site` as the scope:
  `data(002)` for results, `feat(002)` for harness code, `docs(002)`
  for the pages, `docs(readme)` for the front page, `build(site)` for
  the build. One commit per file group; files that cannot work apart
  go together. A commit never rewrites a published result; a redo adds
  the new rows and `data.md` says what the old ones were.

##  Decisions already made

Settled with reasoning attached. Changing one is fine; bring evidence
against the reasoning, not a preference.

**Rules before runs.** Report 001's first round had no decision rule
written first; its second round did, and the difference in how the
result could be read is why everything since preregisters.

**The data holds the numbers; the pages quote them.** A number on a
page that the checks cannot find in the scorer's output is a bug, not
a rounding choice. Where a page rounds, the check rounds the same
way; report 002 rounds half to even on both sides so Python and
JavaScript agree.

**Items as returned, not deduplicated.** Recall counts the first k
items the tool hands the agent, whatever they are: sessions, rows or
chunks. That is what the agent sees. Collapsing repeats is reported as
a post hoc line, never as the headline.

**Controls run every time.** An exact-text control that scores 100
proves the index works, so what follows is about the question asked.
Report 002's OpenClaw control scored 56, and that number explained
the whole result.

**A follow-up round is a new round.** It is preregistered in a dated
section, gets its own cells and issue, and is added to the report
under its own heading. The original verdict stays as read.

**Every record names what answered it.** Model tag, digest and server
version travel with each run, from report 001's issue 1, where a
model tag alone could not say which weights ran.

**Anything a human judged is in the repo,** or the report says it is
not. Report 001 lost one judge's write-up and says so.

**Follow-up questions are preregistered with a hypothesis, including
the one you expect to be wrong.** Report 002's round 4 predicted no
change and was wrong by 22 points; that is the useful outcome.

**Missing exemplars, not thresholds.** When a setup misroutes or
misses, look for the input the test did not cover before reaching for
a tunable. The same rule as in Saxby.

**Scratch is throwaway and outside the build.** `.scratch/report-NNNN`
holds homes, logs, probes and blind-packet keys. The build ignores it;
git never sees it. A key moves into the repo only after the ratings
are in.

**The site is plain Markdown plus comment blocks.** Eleventy 3 with
EJS layouts and the lab's own `markdown-it-comment-blocks` package,
four dev dependencies in all. A site change never changes a number: the
numbers live in data and are test-guarded, so a restyle is never a
research question.

**Tags are fixed versions.** `report-NNN` marks what was published; a
link can point at it; corrections are dated lines on top.

**Canary strings in task files.** Each task's code and tests carry
the canary from the README so trainers can leave them out. It only
works when honoured, so new rounds use new tasks anyway.

**Support happens on GitHub issues only.** Bugs found in other
projects are filed on their trackers, with the measured effect and a
link back, once the maintainer has said to.

---

##  Working on the maintainer's machine

**This section describes one setup and is not a constraint on a
contribution.** It is here because a session started from this folder
runs on that machine, where mistakes have cost real data.

- Apple Silicon M5 Max, 128 GiB, macOS 26, a GPU wired ceiling of
  96 GiB. Ollama on `127.0.0.1:11434` with `bge-m3`; Saxby on
  `127.0.0.1:11435` with `gemma4:31b-128k` as the default model, and a
  raw model name passes straight through.
- **Never touch the production agents or their config:** OpenClaw's
  Aster (`~/.openclaw/`, the gateway on `:18789`), Open WebUI, or
  Saxby's own config. A harness gets its own home under
  `.scratch/report-NNNN/` and its own ports, config path and state
  dir; report 002's `openclaw.py` shows the pattern.
- **Kill by PID only.** Never `pkill` or `killall` by pattern; one bad
  pattern took Docker Desktop down. Stop containers by id.
- **GPU jobs are capped and run one model at a time** where the design
  allows. An uncapped job once panicked the kernel. Check for stray
  containers before a launch; six of them sharing one model timed out
  an extraction in report 002.
- zsh has `noclobber` set: `>` will not overwrite, use `>|`, and `>>`
  refuses a file that does not exist yet, so `touch` log files before
  a background chain appends to them. Commit with explicit pathspecs.
- Hermes cells run in the pinned `nousresearch/hermes-agent` image
  with the harness folder mounted at `/work` and a scratch home at
  `/opt/data`; it reaches Ollama as `host.docker.internal`.
- This repo is on autopilot: commit, push, merge, open and close
  issues, and change settings without asking. Two exceptions: a label
  title needs Niko's approval, and anything that leaves the repo, such
  as an issue on another project's tracker, is asked about first.
