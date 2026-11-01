<!-- lab:label {
  "number": "Saxby lab report No. 003",
  "top": "A sense of",
  "word": "Time",
  "bottom": "Tested with great care"
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
than its own words.

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

<!-- /lab:bar-chart -->

Chance on a two-way question is 50. For the setup with no time
information, the right answer is UNKNOWN, and that column is its
score.

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

Whether the all-or-nothing rule is the runner's or this build's is
open, and it matters: llama.cpp's server normally reuses the longest
common prefix, and a runner that does would charge E only the tail
from the previous message on. That check is [#14][gap-cache]. Until it
is done, the cost column says what this runner charged and nothing
wider.

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

## What this does and does not show

- **The clock is simulated.** Dates and dayparts come from the
  fixtures' times. The model and the runner's cache are real.
- **One model, one runner.** `gemma4:31b-128k` at Q4_K_M on Ollama
  0.40.13's llama.cpp runner. The cache rule found here is that
  runner's; another runner or a later version may reuse prefixes
  differently, and a different model may read the notes differently.
- **Thinking off.** A thinking pass might get more right, at a cost in
  time this night did not budget for.
- **The opener is an instruction.** The forced one-word answer makes
  the score objective and makes the resume less natural. The open
  resume, counted for callbacks only, is the natural case.
- **Short conversations.** Three turns and one resume. Whether a model
  keeps using the notes across a long agent session is a different
  test.
- **Three fixtures resume after midnight.** The night vocabulary
  finding rests on nine rows per arm and was not preregistered.
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
three-turn conversations and a string match. The next round is the
every-message note with the night fixed and the gap sentence kept,
against the same bar, with thinking on as its own arm; it is
[#15][next]. The travel case, where the sender's zone is unknown,
waits behind it.

[next]: https://github.com/saxby-tools/lab/issues/15

<!-- lab:footer -->

Saxby · From the lab · Report No. 003 · Nov. 2026

Data: the fixtures, every reply with its cache counts and the scripts
that rebuild the tables are in [saxby-tools/lab][lab]; `npm test` there
checks every number on this page against them. Harness and write-up
by Claude Code; the question and the bar are Niko's.

[lab]: https://github.com/saxby-tools/lab/tree/HEAD/reports/003-time-notes/

<!-- /lab:footer -->
