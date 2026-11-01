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
  the night at under three hours with them in. At 1:35 a.m. this was
  briefly reversed to seed 1 only on a misread of the clock, which
  made the first arm look like eight seconds a resume; a second look
  at 1:37 showed three, and the extras stayed on for every seed. No
  row was discarded and no seed had run without them.

##  Round 2: every-message notes with a clock

Written on Nov. 1, 2026, between noon and 1 p.m., after round 1 was
published and before any round 2 fixture, renderer change or run
existed. Committed before the first round 2 run; the commit time is
the record. Niko confirmed the bar below in the chat at 11:50 a.m.
("Yes, that's my bar") after Code proposed it with the design, and
chose to leave thinking out. Round 1's verdict and cells are not
touched; round 2 has its own cells under `results/round-2/`.

###  Why a second round

Round 1 left three things unresolved that this round is built to
settle. The every-message note (D) was the cheap one on this runner
but scored 80, and three of its misses in every seed came from the
note's own vocabulary: 1:30 a.m. Monday rendered as "night on
Monday", which the model read as Monday evening ([#13]). Half of the
UNKNOWN replies in the note arms said the user "didn't mention a
specific time" for a daypart such as "in the morning". And the
harness gave every earlier message the fixture's own time, which a
proxy does not have; it has the time it first saw the message.

[#13]: https://github.com/saxby-tools/lab/issues/13

###  Research question

Does a note on every user message, carrying the clock time the proxy
first saw the message, with a gap sentence on the latest one, let the
model act as if time has passed at the bar, including after midnight;
and does the precision of the note matter, against a daypart word
with the small hours named?

###  Hypotheses

- **H7.** DCG scores 90 percent or better on the forced-choice
  resume, mean of three seeds, over all 40 fixtures.
- **H8.** DCG's accuracy on resumes between midnight and 5 a.m. is
  within five points of its accuracy on the rest.
- **H9.** DWG, the daypart word with "early morning" for the small
  hours, lands within five points of DCG. If it does, precision does
  not matter and the choice is free.
- **H10.** DC and DCG report a nonzero cached count on every resume
  and an uncached mean within 25 tokens of round 1's D (107). EC
  reports zero cached on every resume, as round 1's E did.
- **H11.** On the 30 round 1 fixtures alone, DC beats round 1's D
  (80.0) by five points or more: the midnight fix and the daypart
  sentence in the explainer are worth that much.
- **H12.** DCG's UNKNOWN rate is under 5 percent.
- **H13.** On the four fixtures whose "after" resume falls on the same
  weekday as the named one, a week later, DCG gets at least three of
  four right in every seed.

###  Decision rule

Niko's bar, proposed by Code and confirmed by Niko in his own words:
"On ten resumes with the note, the model gets it right nine times.
The note costs no more on the cache than its own words. And the
resumes after midnight are no worse than the rest."

| Mean forced-choice accuracy, arm DCG, all 40 fixtures | Verdict |
| --- | --- |
| 90 percent or higher | Go: build the every-message note with a clock and the gap. |
| Above 70 and below 90 percent | Inconclusive. |
| 70 percent or lower | Fail. |

The verdict is read from arm DCG, mean over three seeds. The second
and third parts of the bar are reported beside it and do not move
the verdict: DCG's uncached tokens against round 1's D plus the
longer note, and DCG's after-midnight accuracy against its accuracy
on the rest.

###  Design: four arms, one model

The persona, the forced-choice tail, the open resume, the what-day
control and the metric are round 1's, unchanged. The explainer gains
two sentences: "A part of the day, such as 'tomorrow afternoon',
counts as a time. Speak of time the way a person would, in days and
parts of the day."

- **DC. Every message, clock.** Every user message starts with
  `[It is 1:30 a.m. on Monday, October 26, 2026.]`, the time the
  proxy first saw that message, fixed from then on. Noon and midnight
  are written as words.
- **DCG. DC plus the gap.** The latest note adds "This conversation
  resumed after {N} hours away." when an hour or more has passed. The
  verdict arm, because it is what Saxby would build.
- **DWG. Every message, daypart word, plus the gap.** As DCG, with the
  round 1 daypart words and one more: "early morning" from midnight
  to 5 a.m. Night is 9 p.m. to midnight.
- **EC. Latest message only, clock.** Round 1's E with the clock
  note, no gap. The bridge between the rounds.

**First-seen times.** A proxy holds nothing between requests and sees
the whole message list on each one, so the time it can put on an
earlier message is the time of the first request that carried that
message. In these fixtures every user turn was its own request, so
the first-seen time of each message is its own send time; a message
pasted in from elsewhere would get the paste time. The renderer
derives the times by that rule rather than reading them as given.

Model, sampling, seeds, warm and resume stages: as round 1. Thinking
stays off; Niko chose to leave a thinking arm out.

###  Fixtures

The 30 from round 1, unchanged, plus ten written for this round:
six whose resumes fall between midnight and 5 a.m., and four whose
window names a weekday and whose "after" resume falls on that
weekday one week later. The same check script, margins and derived
key apply. The ten live in `fixtures-round-2.json`, which includes
round 1's file by reference so the 30 are never copied.

###  Runs

Per seed and arm: 80 forced-choice resumes (40 fixtures, after and
before), 80 open resumes, 40 what-day controls and the repeat floor
on five fixtures, as round 1 ran them. Three seeds, 1 to 3. Rows go
to `results/round-2/seed-N/<arm>.jsonl`; the summary to
`results/round-2/summary/`. Round 1's 30 fixtures are scored on
their own as well as within the 40.

###  Versions pinned

Ollama 0.40.13+saxby.ad4b55d8, `gemma4:31b-128k` digest
`d0e8710a4e62`, both checked on Nov. 1 at noon; otherwise as round 1.

###  What this will not show

Whether the clock note reads well to a person over a long session;
anything about a model other than Gemma 4; the travel case, which
stays a later round.

###  Decided after the plan, round 2

- **Nov. 1, 2026, 12:40 p.m., before the first round 2 run.** Niko
  added, in the chat, that he has met this problem most across
  planning, client approval, revision and implementation chats that
  span weeks and months, where "one thing to think it's last night,
  another to think it's last month," and that his own workaround is
  to resume a long-paused chat with a hand-typed ISO 8601 timestamp
  carrying the zone offset. Three changes follow, none touching the
  verdict. The gap sentence in the round 2 arms counts hours under
  two days, then days, weeks and months, rounded, since "720 hours
  away" is not how anyone says a month; round 1's E2 keeps hours as
  it ran. A fifth arm, **DIG**, stamps every message with the ISO
  form and the offset, `[It is 2026-10-26T01:30-04:00.]`, plus the
  gap, so the round says whether a local model reads Niko's own
  format. And four fixtures, F41 to F44, resume three to seven weeks
  after the named window, in the register of a plan handed off and
  picked up again; they are reported beside the verdict, which stays
  on the 40 fixtures named above, and DIG is reported beside DCG, not
  in its place. The ISO offset also carries the sender's zone, which
  is the travel round's question; nothing here scores that.

##  Round 3: the travel case

Written on Nov. 1, 2026, between 4 and 4:30 p.m., after round 2 was
published and before any round 3 fixture, renderer change or run
existed. Committed before the first round 3 run; the commit time is
the record. Code drafted the design and the bar in the notes dropbox
at 4 p.m.; Niko confirmed the bar in the chat ("That's my bar") and
left the verdict arm and the zones as proposed. Rounds 1 and 2 are
not touched; round 3 has its own cells under `results/round-3/`.

###  Why a third round

Round 2's build order stamps every user message with the proxy's
clock. A proxy on a server stamps in the server's zone, and the user
may be anywhere; a confident note in the wrong zone could be worse
than no note. Round 3 asks what the note must say about its zone,
and what the model should do when the sender's zone is unknown.

###  Research question

When the time note's zone is not the sender's, does the every-message
note let the model act on the sender's time once the sender has said
where they are; and when nobody has said and the zone changes the
answer, does the model ask instead of assuming?

###  Hypotheses

- **H14.** ZN scores 90 percent or better over all 80 resumes, mean
  of three seeds.
- **H15.** ZH, the note in the wrong zone with nothing said, scores
  50 or worse on the resumes where the zone matters.
- **H16.** ZS lands within five points of round 2's DCG (96.7).
- **H17.** ZO lands within five points of ZN.
- **H18.** ZN asks where the user is on fewer than 10 percent of the
  resumes where the zone does not matter.
- **H19.** On the travel fixtures, Tokyo is the zone with the most
  misses, because a fourteen-hour difference crosses the date line.

###  Decision rule

Niko's bar, drafted by Code and confirmed by Niko without change:
"When the user has said where they are, the model gets it right nine
times in ten even though the note is in another zone. When nobody has
said and it changes the answer, it asks nine times in ten. And when
it doesn't change the answer, it doesn't ask."

| Mean accuracy, arm ZN, all 80 resumes | Verdict |
| --- | --- |
| 90 percent or higher | Go: the note carries its zone, and the explainer says what to do without the sender's. |
| Above 70 and below 90 percent | Inconclusive. |
| 70 percent or lower | Fail. |

The verdict is read from arm ZN, mean over three seeds, where a
resume is right when the first word matches its key: PASSED or AHEAD
when the zone is known or does not change the answer, UNKNOWN when it
is unknown and does. The third part of the bar, the pestering rate,
is reported against 10 percent beside the verdict and does not move
it.

###  Design: four arms, one model

Every arm stamps every user message with the clock and the weekday
and puts the gap sentence on the latest note, as round 2's verdict
arm did. The host is America/New_York, EST throughout. The arms
differ only in the zone the note is rendered in, whether the note
names it, and what the explainer says.

- **ZS. Same zone, control.** The note rendered in the sender's own
  zone, unnamed, with round 2's explainer: round 2's DCG with the
  sender wherever they are. Must land within five points of round 2.
- **ZH. Hazard.** The note rendered in the host's zone, unnamed, with
  round 2's explainer: the round 2 build order deployed on a server
  in another zone, with nothing saying so.
- **ZN. Zone named.** The note rendered in the host's zone with its
  abbreviation, `[It is 1:30 p.m. EST on Monday, November 9, 2026.
  This conversation resumed after 27 hours away.]`, and the explainer
  adds: "The note's zone is the system's, which may not be where the
  user is. If the user has said where they are, use that. If their
  place matters to your answer and you do not know it, ask." The
  verdict arm.
- **ZO. Offset.** The ISO form with the host's offset,
  `[It is 2026-11-09T13:30-05:00.]`, on every message, with the same
  explainer and the gap.

Model, sampling, seeds, warm and resume stages, first-seen rule and
the scaled gap sentence: as round 2. Thinking off.

###  Fixtures: 40, all new, two families

Senders are in Europe/Lisbon (UTC), Europe/Berlin (UTC+1),
Asia/Tokyo (UTC+9) or America/Los_Angeles (UTC−8), five of each per
family, all stable offsets through November 2026; every simulated
time is in November after the host's clocks changed. Each fixture
records the sender's zone; its message times and window are in the
sender's local time; the note renders each message's absolute time
in the arm's zone.

**Travel, 20 fixtures: the user has said where they are**, in their
own words in the first message ("Landed in Lisbon, eight in the
morning here"), then a window in local terms. Keys follow from
absolute times in the sender's zone, as in rounds 1 and 2.

**Unknown, 20 fixtures: no message names a place.** For each resume
the check script computes the answer in each of the five zones the
user could be in (the host's and the four above). If the answer is
the same in all five, the zone does not matter and the key is
PASSED or AHEAD. If it differs, the key is UNKNOWN. Fixtures are
built so that, as far as the margins allow, one side matters and the
other does not, so honesty and pestering are scored on the same
conversations. For arm ZS, whose note is in the sender's zone, the
key is always the sender-zone answer.

The check script applies the same margins as before, in the sender's
zone, prints every key, and refuses any fixture it cannot classify.
Nothing is typed by hand.

###  Secondary measures

- **Pestering:** on the resumes where the zone does not matter, the
  share of replies that ask where the user is: a question mark and a
  place or zone word in the reply.
- **The hazard's damage:** ZH against ZS on the resumes where the
  zone matters.
- **Per zone:** accuracy on the travel fixtures by sender zone.
- Cost, the open resume, the what-day control and the repeat floor,
  as before. The what-day control is scored against the sender's
  local weekday and daypart for ZS, and against the host's for the
  others, since that is what each note says.

###  Runs

Four arms, 80 forced resumes each (40 fixtures, after and before),
80 open resumes, 40 controls and the repeat floor on five fixtures,
three seeds. Rows under `results/round-3/seed-N/`, scored with
`--round 3`; the round 1 and round 2 summaries are untouched.

###  Versions pinned

As round 2, checked again before the run.

###  What this will not show

Whether any client tells the proxy where the user is, which decides
whether ZN ever has a stated place to use outside a chat. Half-hour
offsets. A daylight saving change inside a conversation. A sender
whose zone changes between the window and the resume without saying
so.
