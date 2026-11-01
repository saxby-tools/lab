<!-- lab:label {
  "number": "Saxby lab report No. 003",
  "top": "A sense of",
  "word": "Time",
  "bottom": "Test with great care"
} -->

# Time notes on resumed conversations

<!-- /lab:label -->

<!-- lab:deck -->

I left a coding session one night with "I'll leave it for the
morning." When I came back the next afternoon, the assistant still
thought it was that night. Chat apps send the model no clock, or stamp
the date once when a session starts and never again, because changing
anything near the top of the prompt throws away the cached work. So I
tested six ways of telling a local model the time, on 30 conversations
that resume after a gap, and measured what each one costs the cache on
the same turn. The note on the latest message got 82 percent right,
under the 90 I set. A date in the system prompt, stale or fresh, got
the resumed question wrong almost every time. And on this runner the
note on every message was the only one that cost the cache no more
than its own words. A second round the same afternoon, with a clock
time on every message and a sentence naming the gap, cleared the bar
at 97.

<!-- /lab:deck -->

<!-- lab:bar-chart {
  "value": "Right",
  "title": "Resumed after a gap: has the window passed or is it ahead? Right answers, percent, mean of three seeds",
  "max": 100,
  "marker": {"at": 90, "label": "The bar: 90"},
  "label": "Setup",
  "details": true
} -->

| Arm | Setup | Right | UNKNOWN | Uncached tokens |
| --- | --- | --- | --- | --- |
| A | A. Nothing | 88.3 | 88.3 | 89 |
| B | B. Date once | 30.0 | 38.9 | 90 |
| B2 | B2. Date fresh | 30.0 | 42.2 | 189 |
| E | E. Note on latest message | 82.2 | 8.3 | 237 |
| D | D. Note on every message | 80.0 | 8.3 | 107 |
| E2 | E2. Latest message plus gap | 85.6 | 9.4 | 247 |
| DCG | DCG. Every message, clock plus gap (round 2) | 96.7 | 2.5 | 125 |
| DIG | DIG. Every message, ISO stamp plus gap (round 2) | 91.7 | 0.4 | 126 |

<!-- /lab:bar-chart -->

Chance on a two-way question is 50. For the setup with no time
information, the right answer is UNKNOWN, and that column is its
score. The two round 2 bars are over 40 fixtures, the first 30 of
them the same.

## Why I ran it

The screenshot that started this is a Claude Code session offering to
leave a pull request "for the morning," and me, the next afternoon,
telling it that it was now afternoon on day two. The model was not
wrong about anything it had been told. It had been told nothing.

That is the common case, not a bug in one product. The API sends
messages with no timestamps. The apps that do add a date mostly add it
once, at the top of the system prompt, when the session starts.
Hermes Agent tells the model to run `date` in a terminal if it wants
to know. OpenClaw builds a current-time line for its scheduled jobs.
Open WebUI is the exception I found: it re-renders its date variables
on every request. Nobody stamps the messages themselves the way a
messaging app between two people does, and the reason given is the
cache: a local runner reuses the work it did on the unchanged start of
a prompt, and a date that changes near the top forces it to start
over.

I do not want a stopwatch. I want the thing a friend has: a sense that
it is Saturday afternoon and that the last message was Thursday night,
and the honesty to say "I'm not sure what day it is for you" when that
is the truth. The question for Saxby is whether to add a time note to
the messages it forwards, and in which shape: on every message, which
is the messaging-app idea, or on the latest message only, which was
proposed to spare the cache.

## How the test works

**Thirty resumed conversations.** Each is three short turns in the
first person, with a simulated time on every message. In the second
turn the user names a thing and a window for it: "I'm going to do a
Highlander screening tonight, maybe after dinner." Then the
conversation resumes, twice: once after that window has closed, once
while it is still ahead. The windows span the week and the dayparts:
tonight, in the morning, after lunch, before work tomorrow, this
weekend, first thing Monday. A check script refuses any fixture whose
resume is within two hours of the window's edge or three hours of the
last message, and derives the answer key from the times, so none is
close and none is typed by hand. Nothing is copied from a real chat.

**Six ways of telling the model the time.**

- **A. Nothing.** No time anywhere.
- **B. Date once.** A date-and-daypart line in the system prompt,
  rendered from the conversation's first message and never updated.
  This is how the session that started this behaved.
- **B2. Date fresh.** The same line, re-rendered from the current
  time on every turn.
- **E. Note on the latest message.** The latest user message, and only
  it, starts with `[It is afternoon on Wednesday, October 28, 2026.]`.
  A static line in the system prompt explains the notes and says to
  ask when the time or place is unclear.
- **D. Note on every message.** Every user message carries the note
  for its own time, fixed when first seen.
- **E2. E plus the gap.** The latest message's note adds "This
  conversation resumed after 27 hours away."

**The score.** The resume message asks whether the named time has
passed or is still ahead, and to open the reply with exactly one word:
PASSED, AHEAD, or UNKNOWN if it cannot tell. A regular expression reads
the word; nothing judges the rest. With time information, PASSED or
AHEAD must match the key. With none, the right answer is UNKNOWN, and a
guess that lands right is still a guess. That one-word opener is an
instruction a person would not type, and it is the price of a score
no model grades.

**The cost.** Every resume is measured the way a client would send it:
the previous turn is sent first and the model answers it for real, so
the runner's cache holds that turn; then the resume goes, and Ollama
reports how many of its prompt tokens came from the cache. The
difference is what the turn cost. A repeat control sends the same
resume twice and reports the floor the runner charges for anything.

**The bar,** in my words from before the run: on ten resumes with the
note, the model gets it right nine times; without any time, it says it
does not know at least nine times in ten rather than guessing; and the
note costs no more on the cache than its own words. Applied to the full
set, 90 percent or better on arm E is a go, 70 or worse a fail, and
the verdict is read from E. Three seeds, every reply sampled at the
model's own temperature with the seed fixed. The
[preregistration][prereg] has the hypotheses, including one that
turned out wrong, and the one change made before the first run.

[prereg]: https://github.com/saxby-tools/lab/blob/HEAD/reports/003-time-notes/preregistration.md

## What the numbers say

<!-- lab:data-table -->

| Arm | What | Right | After | Before | UNKNOWN | Uncached tokens | 95 percent interval |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Nothing: no time anywhere | 88.3 | 87.8 | 88.9 | 88.3 | 89 | 81.2 to 95.5 |
| B | Date once, in the system prompt, never updated | 30.0 | 0.0 | 60.0 | 38.9 | 90 | 22.8 to 37.2 |
| B2 | Date fresh, in the system prompt, every turn | 30.0 | 3.3 | 56.7 | 42.2 | 189 | 25.9 to 34.1 |
| E | Note on the latest user message only | 82.2 | 80.0 | 84.4 | 8.3 | 237 | 79.8 to 84.6 |
| D | Note on every user message | 80.0 | 77.8 | 82.2 | 8.3 | 107 | 71.7 to 88.3 |
| E2 | Note on the latest message, plus the gap | 85.6 | 86.7 | 84.4 | 9.4 | 247 | 83.2 to 87.9 |

Right answers, percent, mean of three seeds; "After" and "Before" split
the resumes by whether the window had closed. UNKNOWN is the share of
replies that opened with that word. Uncached tokens are the prompt
tokens the runner had to process again on the resume turn, mean over
the forced resumes. The interval is a t-interval over the three seed
means.

<!-- /lab:data-table -->

**Verdict at the preregistered bar: **inconclusive**.** Arm E, named
in advance as the one the verdict reads from, came in at 82.2 percent:
above the 70 that would have called the note a failure, under the 90 I
asked for. The other two parts of the bar: with no time at all the
model said UNKNOWN 88.3 percent of the time, a hair under nine in ten;
and the note on the latest message cost the whole prompt, not its own
words. The note on every message is the one that met that part.

Six hypotheses went in. Three held, two fell, one split. B, the date
set once and never updated, scored zero on every resume that crossed
the window, as predicted: it believes the start time. E did not reach
90. The model with no time information did not guess: it said UNKNOWN
88 percent of the time, which I had bet against. D and E landed within
five points of each other, 2.2 apart. The cache hypothesis held for
B2 and fell for E, below. And E2's gap sentence added 3.4 points to E,
under the five the rule asked for, with the whole gain on the resumes
after the window: 86.7 against 80.0.

The result I did not see coming is B2. A date and daypart line in the
system prompt, re-rendered from the current time on every turn, is
what Open WebUI does, and it is the obvious fix for the stale-date
session that started this. It scored 3.3 percent on the resumes after
the window. Not because the model missed the date: on the what-day
control it named the weekday and daypart right every time. Here it is
on the Highlander fixture, resumed the next afternoon, with "The
current date and time: Wednesday, October 28, 2026, afternoon" in its
system prompt:

> AHEAD. Since it's only afternoon, you've still got time for dinner
> and the movie!

The earlier turns carry no time, so "tonight" reads as tonight of
whatever day the clock says. A current clock answers "what time is
it." Resuming needs "when was that said," and only a note on the
message itself carries it. B2 did a little worse than B on the
resumes before the window too, so the fresh clock bought nothing at
all on this question.

Where the notes fail, three patterns account for nearly every miss.
The first is a relative word anchored to the wrong day. "I'll mow the
lawn this weekend," said on a Wednesday and asked about on the Monday
after, drew "You've still got a few days before the weekend hits" from
E in every seed, and the same happened to "this evening," "tonight"
and "tomorrow afternoon" when the resume crossed a day. That is the
case the note on every message was designed for, and D got three of
E's four such fixtures right. It lost others, two of them on "first
thing Monday" asked on the Monday, where the model answered as if the
thing were happening now. The second pattern is UNKNOWN for a window
named by a daypart. Half of E's UNKNOWN replies said the user "didn't
mention a specific time" for "in the morning" or "tomorrow afternoon."
To this model a part of the day is not a time, and the explainer line
did not say otherwise.

The third I found after the run, so it is post hoc and the counts are
small. Three fixtures resume between midnight and 5 a.m., nine forced
rows per arm. D got none of the nine right; E and E2 got six. The note
for 1:30 a.m. Monday reads `[It is night on Monday, October 26,
2026.]`, and the model read "Monday night" as the end of Monday, a day
later than it was:

> PASSED. It's already Monday night, so you missed the morning window.

People call that hour Sunday night. That is my vocabulary, not the
model's, and D suffered most because the previous message's "night on
Sunday" note sat right above it. It is filed as [#13][gap-night] and
goes into the next round's note format.

[gap-night]: https://github.com/saxby-tools/lab/issues/13

## What the cache actually does

The cache hypothesis said the note on the latest message would cost
its own words plus the message, and that re-rendering a date line in
the system prompt would cost the whole prompt. The second half held.
The first was wrong, on this runner, in a way that reverses the reason
E existed.

Ollama reports how many prompt tokens the runner took from its cache.
On this build, driving the llama.cpp server runner, that number was
all or nothing: the runner reused the cached work when the new prompt
extended the old one, and reported zero when anything inside the
cached span differed, even with an identical system prompt and two
identical turns in front of the change. E and E2 reported zero cached
tokens on 180 of 180 forced resumes. B2 reported zero on 168, and the
12 exceptions are the same-day resumes whose date line happened not to
change. A, B and D never reported zero.

The reason is in how E works. Moving the note from the previous user
message to the new one edits the previous message, and an edited
message inside the cached span cost everything. D never edits a
message: each note is fixed when first seen, so the resume only
extends the prompt, and its cost is A's plus the 18 tokens of the note
itself. In time, on this machine, the prompt step averaged 450
milliseconds for A and 753 for E, with D at 501. On a three-turn
conversation that is a third of a second; on a long agent session the
whole prompt is the whole session.

Why it is all or nothing turned out to be the model, not Ollama. The
morning after, I hit the same runner process directly, with no Ollama
in the loop, and it gave the same answer for Gemma 4: zero on any
change inside the prompt, even one word in the last sentence. Its log
says why. It forces a full reprocess "due to lack of cache data
(likely due to SWA or hybrid/recurrent memory)." Gemma 4 uses
sliding-window attention, which keeps no full history to roll back
to, so llama.cpp can only resume from a checkpoint, and it spaces
those 8,192 tokens apart. A short conversation never has one. Granite
4, whose layers are partly recurrent, behaved the same way through
Ollama. Voxtral Mini, a plain full-attention model, reused the common
prefix on the same probe, 156 of 192 tokens after a change in the
first user message. So the cost finding holds for Gemma 4 and models
built like it on llama.cpp as Ollama runs it. On a full-attention
model E would cost only the tail from the changed message on, and D's
advantage would shrink to nothing. That check was [#14][gap-cache],
closed with the numbers.

[gap-cache]: https://github.com/saxby-tools/lab/issues/14

<!-- lab:data-table -->

| Arm | What | Uncached, system prompt unchanged | Uncached, system prompt changed | Repeat floor |
| --- | --- | --- | --- | --- |
| A | Nothing: no time anywhere | 89 | n/a | 5 |
| B | Date once, in the system prompt, never updated | 90 | n/a | 5 |
| B2 | Date fresh, in the system prompt, every turn | 90 | 196 | 5 |
| E | Note on the latest user message only | 237 | n/a | 5 |
| D | Note on every user message | 107 | n/a | 5 |
| E2 | Note on the latest message, plus the gap | 247 | n/a | 5 |

Mean uncached prompt tokens on the resume turn. The system prompt
changes between turns only in B2. The repeat floor is the second of
two identical sends.

<!-- /lab:data-table -->

## Honesty, echoes and callbacks

Three smaller counts ran beside the main one, on all three seeds.

<!-- lab:data-table -->

| Arm | What | What-day right | Says start time | Callback |
| --- | --- | --- | --- | --- |
| A | Nothing: no time anywhere | 4.4 | 3.3 | 72.2 |
| B | Date once, in the system prompt, never updated | 3.3 | 100.0 | 74.4 |
| B2 | Date fresh, in the system prompt, every turn | 100.0 | 3.3 | 72.8 |
| E | Note on the latest user message only | 100.0 | 3.3 | 82.2 |
| D | Note on every user message | 100.0 | 3.3 | 76.1 |
| E2 | Note on the latest message, plus the gap | 97.8 | 3.3 | 79.4 |

Percent of replies, three seeds pooled. "What-day right" is the share
of what-day controls naming the resume's weekday and daypart; "Says
start time" the share naming the conversation's first weekday and
daypart instead. "Callback" is the share of open resumes that mention
the fixture's own words for the thing.

<!-- /lab:data-table -->

**The what-day control** asked, on the resumes after the window,
what day of the week it was and what part of the day. Every arm with
a current time named both right, all or nearly all of the time. B,
with the stale date, named the conversation's first day instead,
every single time, with no hedge. A guessed.

**No reply echoed a note.** The explainer line says never to write
the notes yourself, and across 1,080 replies in the three note arms
none opened a bracket with "It is." Every forced reply, in every arm,
began with one of the three words; the format-miss count is zero.

**Callbacks** are the count I care most about and trust least. The
open resume says only "Hey, picking this back up," and the count is
whether the reply mentions the fixture's own words for the thing. E
did so on 82 percent of open resumes, A on 72. On the Highlander
fixture, A said "Did you end up watching it?" and E said "How was the
movie?", which is the difference between a friend who thinks it might
still be that evening and one who knows it is not. But it is a string
match on short replies, and ten points over three seeds is a lean, not
a finding.

**The repeat floor** was five tokens in every arm: the least this
runner charges for a resend it has seen before.

## Round 2: every message, with a clock

Run the same afternoon, preregistered as round 2 before any of it
existed, with its own cells; the verdict above stands as read. The
bar, in Niko's words: "On ten resumes with the note, the model gets
it right nine times. The note costs no more on the cache than its
own words. And the resumes after midnight are no worse than the
rest." It reads from one arm, the every-message note with a clock
time and a gap sentence, over 40 fixtures: round 1's 30, six that
resume between midnight and 5 a.m., and four whose "after" resume
falls on the named weekday one week later. Four more fixtures resume
three to seven weeks after the window, in the register of a plan
handed off and picked up again; they are reported beside the verdict.

**Five arms.** Every note carries the time the proxy first saw the
message, which for these fixtures is the message's own time. The
explainer line gained two sentences: a part of the day counts as a
time, and speak of time the way a person would.

- **DC. Every message, clock.** `[It is 1:30 a.m. on Monday, October
  26, 2026.]` on every user message, fixed when first seen.
- **DCG. DC plus the gap.** The latest note adds "This conversation
  resumed after 27 hours away," in hours under two days, then days,
  weeks and months. The verdict arm.
- **DWG. Every message, daypart word, plus the gap.** Round 1's words
  with one more, "early morning" from midnight to 5 a.m.
- **DIG. Every message, ISO stamp, plus the gap.** Niko's own
  workaround for a long-paused chat: `[It is 2026-10-26T01:30-04:00.]`.
- **EC. Latest message only, clock.** Round 1's E with the clock.

<!-- lab:data-table -->

| Arm | What | Right | After | Before | UNKNOWN | Uncached tokens | 95 percent interval |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DC | Every message, clock time | 88.8 | 80.8 | 96.7 | 5.0 | 115 | 85.6 to 91.9 |
| DCG | Every message, clock time, plus the gap | 96.7 | 95.8 | 97.5 | 2.5 | 125 | 94.9 to 98.5 |
| DWG | Every message, daypart word, plus the gap | 81.2 | 81.7 | 80.8 | 7.5 | 117 | 78.1 to 84.4 |
| DIG | Every message, ISO 8601 with offset, plus the gap | 91.7 | 92.5 | 90.8 | 0.4 | 126 | 89.9 to 93.5 |
| EC | Latest message only, clock time | 76.2 | 56.7 | 95.8 | 1.2 | 279 | 70.9 to 81.6 |

As the table above, over the 40 verdict fixtures, three seeds.

<!-- /lab:data-table -->

**Verdict at the preregistered bar, round 2: **go**.** The
every-message note with the clock and the gap scored 96.7 percent,
seeds 96.2, 97.5 and 96.2, with the interval clear of 90. The other
two parts of the bar held too: its resume cost 125 uncached tokens,
against 107 for round 1's every-message note and 89 for no note,
with the cache taken on every one of 264 resumes; and the resumes
between midnight and 5 a.m. scored 100 against 96 on the rest.

Three things moved it, and they pull apart cleanly in the arms.

**The clock instead of the word.** On round 1's own 30 fixtures the
every-message note went from 80.0 to 90.0 with nothing else changed
but the note's shape and the explainer, and the after-midnight
resumes went from none right to all right. The daypart word with
"early morning" did not get there: 81.2 overall, 74.4 after midnight.
The model read "early morning" as not being told the time: "I don't
have the exact time right now, only that it's early morning," and
said UNKNOWN. A word that names a span is read as a span; a clock is
read as a fact.

**The gap sentence.** It is the larger lever. The clock alone scored
88.8; with the sentence, 96.7, and on the resumes after the window
80.8 became 95.8. On the four fixtures whose resume lands on the
named weekday a week later it was the whole difference: one in four
right without the sentence, eleven in twelve with it. Asked on a
Tuesday about a demo "at Tuesday's standup" named twelve days before,
the clock arm said it did not know when the standup was; the same arm
with "This conversation resumed after 12 days away" said:

> PASSED. You mentioned it was for the standup on Tuesday, but today
> is already Tuesday, November 3rd. How did it go?

A clock tells the model what time it is. The gap tells it how much
time has passed. For this model those are two facts, not one, and
the second is the one resuming needs.

**Niko's format.** The ISO stamp with the offset scored 91.7, above
the bar on its own, and almost never hedged: UNKNOWN on one reply in
240. On the long-gap fixtures it scored 87.5 and on the week-on ones
100. It paid in one place. On the what-day control it named the wrong
weekday on 11 of 132 replies, where every clock arm, whose note
carries the weekday, named a wrong one on none. A model can read
`2026-10-25` and still call it Monday. The note that says "Sunday"
never has that problem, and what day it is happens to be the one fact
a friend never gets wrong.

**The latest-message note did not improve with a clock.** EC scored
76.2, under round 1's E, and 62.5 on the long-gap fixtures: three
weeks after "the migration dry run is tomorrow afternoon," it said
"You're still set for tomorrow afternoon at 2:00," and seven weeks
after a lease due "this weekend," "You've still got a few days before
the weekend." That is the last-night-versus-last-month failure in
its purest form, and it is a property of where the note sits, not
what it says. The cost finding held again too: zero cached tokens on
all 264 of its resumes, 279 uncached, against 125 for the arm that
never edits a message.

The one fixture the verdict arm missed in every seed is round 1's
"I'll reply to Brian tomorrow afternoon with some times": asked on
that afternoon's evening, it still opened with UNKNOWN because "you
hadn't picked specific times yet." The explainer's new sentence
cleared most of those; not this one.

<!-- lab:data-table -->

| Arm | What | Midnight to 5 a.m. | The rest | Round 1's 30 | Week on, after | Long gap |
| --- | --- | --- | --- | --- | --- | --- |
| DC | Every message, clock time | 100.0 | 86.6 | 90.0 | 25.0 | 100.0 |
| DCG | Every message, clock time, plus the gap | 100.0 | 96.0 | 96.1 | 91.7 | 100.0 |
| DWG | Every message, daypart word, plus the gap | 74.4 | 82.6 | 81.7 | 58.3 | 100.0 |
| DIG | Every message, ISO 8601 with offset, plus the gap | 100.0 | 90.0 | 91.7 | 100.0 | 87.5 |
| EC | Latest message only, clock time | 87.2 | 74.1 | 76.1 | 25.0 | 62.5 |

Right answers, percent, pooled over three seeds. "Midnight to 5 a.m."
is 39 resumes and "the rest" 201, both within the 40 verdict
fixtures; "week on, after" is the four fixtures resumed on the named
weekday a week later, after side only; "long gap" is the four
fixtures resumed three to seven weeks on, both sides.

<!-- /lab:data-table -->

**The smaller counts** ran again. Callbacks on the open resume sat
between 76 and 82 percent in every arm, where round 1 had 72 with no
note. The what-day control is a string match for the weekday and one
of my daypart words, and with a clock in the note the model often
answered in its own words instead: "It's Sunday at noon," "It's
Wednesday night" at 8:30 p.m. Those count as misses in the table and
are not; the number that matters from that control is the wrong
weekday count above, zero for every arm but the ISO one.

**Does a note in stored text hurt memory?** Niko asked whether a time
note would move the embeddings a memory plugin searches. Saxby's
notes never reach that store, because a client saves what was typed
before the proxy sees it, but the question stands for any client that
stamps before saving. A probe with report 002's 120 invented facts
and their 240 paraphrased queries, each fact embedded with bge-m3 as
is and with each note shape in front, says no:

<!-- lab:data-table -->

| Condition | What | At 1 | At 5 | At 10 |
| --- | --- | --- | --- | --- |
| plain | Fact text as is | 81.2 | 98.8 | 100.0 |
| word | Daypart word note in front | 84.9 | 100.0 | 100.0 |
| clock | Clock time note in front | 86.4 | 99.7 | 100.0 |
| iso | ISO 8601 note in front | 85.7 | 99.4 | 100.0 |

Recall at k over 120 rows, percent, mean of three seeds of drawn
times. Easier than report 002's chunked diary, since each row is one
fact, so read the differences, not the levels.

<!-- /lab:data-table -->

A note in front pulls the rows closer together, as a shared prefix
must, but the gap between the right row and the best wrong one does
not move, and recall at one goes up a few points rather than down.
The scripts and counts are with the round 2 data.

## What this does and does not show

- **The clock is simulated.** Dates and dayparts come from the
  fixtures' times. The model and the runner's cache are real.
- **One model, one runner.** `gemma4:31b-128k` at Q4_K_M on Ollama
  0.40.13's llama.cpp runner. The cache rule found here is llama.cpp's
  for a sliding-window or hybrid model; a full-attention model reuses
  the common prefix, and a different model may read the notes
  differently.
- **Thinking off.** A thinking pass might get more right, at a cost in
  time this night did not budget for.
- **The opener is an instruction.** The forced one-word answer makes
  the score objective and makes the resume less natural. The open
  resume, counted for callbacks only, is the natural case.
- **Short conversations.** Three turns and one resume. Whether a model
  keeps using the notes across a long agent session is a different
  test.
- **Three fixtures resume after midnight** in round 1; the night
  vocabulary finding there rests on nine rows per arm and was not
  preregistered. Round 2 added six and scored them in advance.
- **Round 2's fixtures were written knowing round 1's misses.** The
  ten added to the verdict set target the small hours and the
  weekday-a-week-on trap on purpose. On round 1's untouched 30 alone
  the verdict arm scored 96.1, so the verdict does not ride on them.
- **No travel.** Every time is in one zone. The case where the sender's
  zone is unknown is the next round, and its design is already
  written up in the lab's notes.

## What I take from it

I asked whether Saxby should stamp the messages it forwards with the
time, and the answer the bar gives is "not yet, not like this." The
note on the latest message did not clear 90, and the thing it was
built to protect, the cache, it did not protect on this runner.

What I take instead is three things settled enough to act on. A date
in the system prompt is the wrong tool for resuming, however often it
is refreshed, because the question is never what time it is now but
when the earlier words were said. A note that travels with each
message answers that, and on this runner it is also the cheap one,
because it never edits what the runner has already seen. And the
note's own vocabulary has to survive midnight.

The honesty result I will keep too. Told nothing, this model said it
did not know 88 times in 100, and its guesses came on fixtures that
named a weekday, where it assumed little time had passed. A model that
admits the gap is a better partner than one that fills it, and the
note arms traded that admission away: with a time in hand they said
UNKNOWN 8 percent of the time and were wrong on roughly another ten.

For the storyline I actually want, a sense of time is a precondition,
not the feature. The callback count moved ten points with a note, on
three-turn conversations and a string match.

**Round 2 turned that into a build order.** The every-message note
with a clock time, the weekday, and a sentence naming the gap cleared
the bar with room, kept the cache, and held after midnight and across
a seven-week pause. So Saxby's `message_prefix` is: every user
message, stamped with the time the proxy first saw it, as a clock
with the weekday, and on the latest message a sentence saying how long
it has been, in the unit a person would use. Niko's hand-typed ISO
stamp works nearly as well and is what to type until that exists; put
the weekday in it. What the round did not settle is the travel case,
where the sender's zone is unknown, which is the next round ([#15]
closed this one). The verdict of round 1 stands as read: the
latest-message note, in either shape, is the wrong design.

[#15]: https://github.com/saxby-tools/lab/issues/15

<!-- lab:footer -->

Saxby · From the lab · Report No. 003 · Nov. 2026 · Round 2 added
the same day

Data: the fixtures, every reply with its cache counts and the scripts
that rebuild the tables are in [saxby-tools/lab][lab]; `npm test` there
checks every number on this page against them. Harness and write-up
by Claude Code; the question and the bar are Niko's.

[lab]: https://github.com/saxby-tools/lab/tree/HEAD/reports/003-time-notes/

<!-- /lab:footer -->
