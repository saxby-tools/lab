#  Preregistration: time notes on resumed conversations

Written on Nov. 1, 2026, between 1:20 and 1:45 a.m., before any
fixture, harness or run existed. Committed before the first run; the
commit time is the record. Niko's brief arrived through the notes
dropbox on Nov. 1 (the chat note `temporal-injection`); Code's reply
note shaped the test; Niko said late on Nov. 1 that the brief had
what it needed and to run it overnight, with the bar as drafted and
no changes asked for.

##  Research question

When a conversation resumes after a gap, does a time note on the
latest user message let a local model act as if time has passed,
compared with no time information, with a date set once in the
system prompt, and with a date kept fresh in the system prompt; and
what does each cost in prompt tokens that the cache cannot reuse?

The decision it informs: whether Saxby grows a `message_prefix`, and
in which shape. Every user message stamped (D) is Niko's raw idea,
"like a messaging app does." The last user message only (E) is the
refinement that protects the prompt cache. The test is whether E
keeps D's result for less.

##  Hypotheses

Written so that each can be wrong.

- **H1.** B, the date set once at the start, scores at or below
  chance on resumes that crossed the named window, because it still
  believes the start time.
- **H2.** E scores 90 percent or better on the forced-choice resume.
- **H3.** A, with no time information, says UNKNOWN less than half
  the time: the model guesses rather than admits.
- **H4.** D and E are within five points of each other.
- **H5.** E's uncached prompt tokens on the resume turn are the note
  plus the message plus the repeat floor, within 20 tokens. B2
  reprocesses the whole prompt whenever its date line has changed.
- **H6.** E2 beats E by less than five points. If it beats it by more,
  the gap sentence earns its place.

##  Decision rule

Niko's bar, drafted by Code in Niko's words and accepted without
change: "On ten resumes with the note, the model gets it right nine
times. Without any time, it says it does not know at least nine times
in ten rather than guessing. And the note costs no more on the cache
than its own words."

| Mean forced-choice accuracy, arm E | Verdict |
| --- | --- |
| 90 percent or higher | Go: build the last-message note. |
| Above 70 and below 90 percent | Inconclusive. |
| 70 percent or lower | Fail: the note does not fix resuming. |

The verdict is read from arm E, mean over three seeds. The second and
third parts of the bar are reported beside it and do not move the
verdict: A's UNKNOWN rate against 90, and E's uncached tokens against
its note length plus the repeat floor.

##  Metric

Every fixture is a short conversation in which the user names a
window for something ("maybe tonight", "in the morning", "this
weekend"), then resumes after a simulated gap. Each fixture resumes
twice: once after the window closed, once while it is still ahead.
The resume message asks whether the named time has passed or is still
ahead, and to open the reply with exactly one word: PASSED, AHEAD or
UNKNOWN. A regular expression reads the first word; nothing judges
the rest.

- Arms with time information: PASSED or AHEAD, matching the key.
- Arm A, no time information: UNKNOWN is the right answer. A guess
  that happens to be right is still wrong.
- A reply with no recognised first word counts as a miss and is also
  reported as a format miss.

Secondary measures, descriptive, not part of the verdict:

- **UNKNOWN rate** per arm.
- **Echo rate:** the note's text repeated in the reply.
- **Callback rate:** on a second, open resume ("hey, picking this back
  up") with no question in it, whether the reply mentions the thing
  the user had named, by a per-fixture keyword list. Seed 1 only.
- **What-day control:** a resume that asks for the day of the week
  and part of the day in one line, scored against the note's own
  words. Arms with a note must score 100. Arm B is scored against the
  stale start date, which shows what it believes. Seed 1 only.
- **Cost:** `prompt_eval_count - prompt_eval_cached_count` on the
  resume request, after a warm request that put the conversation's
  previous state in the cache. A repeat control sends the same resume
  twice and reports the second's uncached count as the floor the
  runner cannot go below. Five fixtures per arm, seed 1.

The warm request is the full prior history, ending with the last
scripted assistant reply, with one token of generation. It stands in
for the previous turn as the arm would have sent it: in E the note is
on the last prior user message, because it was the latest message
then; in D every prior user message is stamped; in B and B2 the
system prompt carries the start date. The resume request is then
exactly what the arm would send next.

##  Design: six arms, one model

A fixed persona system prompt is shared by every arm. The arms differ
only in time text.

- **A. Nothing.** No time anywhere.
- **B. Date once.** The system prompt gets "The current date and time:
  Tuesday, October 27, 2026, evening" rendered from the conversation's
  start, never updated. The bug reproducer.
- **B2. Date fresh.** The same line, re-rendered from the resume time.
  What Open WebUI does with its date variables.
- **E. Note on the last user message.** The system prompt adds the
  static explainer; the latest user message, and only it, starts with
  `[It is {daypart} on {date}.]`.
- **D. Note on every user message.** Same explainer; every user message
  carries the note for its own time, fixed when first seen.
- **E2. E plus a gap sentence.** The resume note reads
  `[It is {daypart} on {date}. This conversation resumed after {N}
  hours away.]` when the gap since the previous message is an hour or
  more.

Explainer, static, in E, D and E2 only: "User messages may start with
a bracketed note about the current time, added by the system. Use it.
Never write these notes yourself. If the time or place is unclear and
it matters for your answer, ask."

Dayparts: morning 5 a.m. to noon, afternoon noon to 5 p.m., evening 5
to 9 p.m., night 9 p.m. to 5 a.m. Noon is afternoon. Dates are
rendered in America/New_York as "Tuesday, October 27, 2026". The
clock is the fixture's simulated clock, not the machine's.

Model: `gemma4:31b-128k` through Ollama's native `/api/chat` on
`127.0.0.1:11434`, digest recorded per run, with the model's own
sampling defaults (temperature 1, top_k 64, top_p 0.95), `num_predict`
200, thinking off, and `seed` set to the seed number. Three seeds
are three full passes with seeds 1, 2 and 3; the fixtures do not
change between them.

##  Fixtures

Thirty, written by Code before the harness ran, in the register of a
real resumed chat: two to four short exchanges in the first person,
one of which names a thing and a window for it, each message with a
simulated time. Windows span the dayparts and the week: tonight, in
the morning, after lunch, before work tomorrow, this weekend, first
thing Monday, later today, tomorrow. For each fixture the file
records when the window closes, a resume time after it and a resume
time before it, each at least two hours from the window's edge and at
least three hours after the last message, so no fixture is close. A
check script refuses a fixture that breaks those margins, and the
answer key is computed from the times, never typed by hand.

Nothing in a fixture is copied from a real conversation.

##  Runs

Per seed and arm, 60 forced-choice resumes (30 fixtures, after and
before). Seed 1 adds the open resume, the what-day control and the
repeat floor. Every resume request is preceded by its own warm
request so the cost reads the true per-turn change. Requests run one
at a time; nothing else uses the model.

##  Versions pinned

- Ollama 0.40.13+saxby.ad4b55d8 (the ollama-saxby build), llama.cpp
  runner.
- `gemma4:31b-128k`, Q4_K_M, 31.3B parameters, `num_ctx` 131072;
  full digest in `data.md`.
- Apple M5 Max, 128 GiB, macOS 26.
- Harness: Python 3 standard library on the host.

##  What this will not show

Whether a model keeps using the note across a long agent session;
whether real phrasing matches the fixtures; anything about minutes;
the cold-cache case, where the model had unloaded and every arm pays
a full prefill alike; and the travel case, where the sender's time
zone is unknown, which is a later round.

##  Decided after the plan

- **Nov. 1, 2026, 1:30 a.m., before the first run:** the warm request
  is not the history ending with a scripted assistant reply. A probe
  against the runner showed it takes a prefix back from its cache
  only when the new prompt extends what the cache holds, and a prompt
  that ends on an assistant message cannot be extended, because the
  model continues it. So the warm request is the turns up to the last
  user message, answered by the model for real, and the resume sends
  those turns as the arm renders them now, the model's own reply, and
  the resume message. That is what a real client sends. The scripted
  final assistant lines were removed from the fixtures. In arms E and
  E2 the note moves off the previous user message at the resume, and
  in B2 the system prompt changes, so those prompts differ inside the
  cached span; whether the runner then reuses anything is part of
  what the cost column measures, and H5 stands as written.
- **Same time:** the open resume, the what-day control and the repeat
  floor run on all three seeds, not seed 1 only; the smoke test put
  the night at under three hours with them in.
