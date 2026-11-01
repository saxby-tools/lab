#!/usr/bin/env python3
"""Turn a fixture into the messages each arm would send.

Two stages per resume. The warm stage is the conversation as the arm
sent it on its previous turn: the scripted turns up to the last user
message, which the model then answers for real. The resume stage is
what the arm sends next: the same turns as the arm renders them now,
the model's own reply from the warm stage, and the resume message.
That is what a real client sends, and the only shape whose prefix
this runner takes back from its cache.

Round 1:

    A   nothing
    B   date line in the system prompt from the first message, fixed
    B2  date line in the system prompt, re-rendered every turn
    E   note on the latest user message only
    D   note on every user message, fixed at its own time
    E2  E, plus a gap sentence when an hour or more has passed

Round 2, with the clock and the first-seen rule:

    DC   note on every user message, clock time, fixed when first seen
    DCG  DC, plus the gap sentence on the latest note
    DWG  every message, daypart word with "early morning", plus the gap
    DIG  every message, ISO 8601 with the offset, plus the gap
    EC   note on the latest user message only, clock time

Round 2's gap sentence counts hours under two days, then days, weeks
and months; round 1's E2 counts hours only, as it ran.

Round 3, the travel case: every arm is DCG's shape, the sender is in
another zone, and the arms differ in the zone the note is rendered in
and whether it says so.

    ZS   note in the sender's own zone, unnamed (control)
    ZH   note in the host's zone, unnamed (the hazard)
    ZN   note in the host's zone, named: "1:30 p.m. EST on Monday..."
    ZO   ISO 8601 with the host's offset

Licence: AGPL-3.0-or-later.
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

import zones  # noqa: E402

ARMS = ["A", "B", "B2", "E", "D", "E2"]
ARMS_ROUND_2 = ["DC", "DCG", "DWG", "DIG", "EC"]
ARMS_ROUND_3 = ["ZS", "ZH", "ZN", "ZO"]

NOTE_ARMS = {"E", "D", "E2"}
NOTE_ARMS_ROUND_2 = {"DC", "DCG", "DWG", "DIG", "EC"}
NOTE_ARMS_ROUND_3 = {"ZS", "ZH", "ZN", "ZO"}

EVERY_MESSAGE_ARMS = {"D", "DC", "DCG", "DWG", "DIG", "ZS", "ZH", "ZN", "ZO"}
LATEST_ONLY_ARMS = {"E", "E2", "EC"}
GAP_ARMS = {"E2", "DCG", "DWG", "DIG", "ZS", "ZH", "ZN", "ZO"}
CLOCK_ARMS = {"DC", "DCG", "EC", "ZS", "ZH"}
ZONE_NAMED_ARMS = {"ZN"}
WORD_ARMS_ROUND_2 = {"DWG"}
ISO_ARMS = {"DIG", "ZO"}
SENDER_ZONE_ARMS = zones.SENDER_ZONE_ARMS

EXPLAINER = (
    "User messages may start with a bracketed note about the current "
    "time, added by the system. Use it. Never write these notes "
    "yourself. If the time or place is unclear and it matters for your "
    "answer, ask."
)

EXPLAINER_ROUND_2 = EXPLAINER + (
    " A part of the day, such as 'tomorrow afternoon', counts as a "
    "time. Speak of time the way a person would, in days and parts of "
    "the day."
)

EXPLAINER_ROUND_3 = EXPLAINER_ROUND_2 + (
    " The note's zone is the system's, which may not be where the "
    "user is. If the user has said where they are, use that. If their "
    "place matters to your answer and you do not know it, ask."
)

GAP_HOURS_MIN = 1
GAP_DAYS_FROM = 48
GAP_WEEKS_FROM = 14 * 24
GAP_MONTHS_FROM = 8 * 7 * 24
HOURS_PER_MONTH = 730

EARLY_MORNING_END = 5


def load_fixtures(path):
    """The fixture file; "includes" prepends a base file's fixtures,
    "inherits" takes a base file's settings and none of its fixtures."""
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))

    if "inherits" in data:
        base = load_fixtures(path.parent / data["inherits"])
        merged = {k: v for k, v in base.items() if k != "fixtures"}
        merged.update(data)
        return merged

    if "includes" not in data:
        return data

    base = load_fixtures(path.parent / data["includes"])
    merged = dict(base)
    merged["fixtures"] = base["fixtures"] + data["fixtures"]
    return merged


def when(text, zone):
    return datetime.fromisoformat(text).replace(tzinfo=zone)


def daypart(moment):
    hour = moment.hour

    if 5 <= hour < 12:
        return "morning"

    if 12 <= hour < 17:
        return "afternoon"

    if 17 <= hour < 21:
        return "evening"

    return "night"


def daypart_round_2(moment):
    """Round 1's words, with the small hours named."""
    if moment.hour < EARLY_MORNING_END:
        return "early morning"

    return daypart(moment)


def date_text(moment):
    return f"{moment:%A, %B} {moment.day}, {moment:%Y}"


def clock_text(moment):
    if moment.hour == 12 and moment.minute == 0:
        return "noon"

    if moment.hour == 0 and moment.minute == 0:
        return "midnight"

    hour = moment.hour % 12 or 12
    suffix = "a.m." if moment.hour < 12 else "p.m."
    return f"{hour}:{moment:%M} {suffix}"


def gap_sentence(gap_hours):
    return f" This conversation resumed after {gap_hours} hours away."


def gap_text_round_2(gap_hours):
    """Hours under two days, then days, weeks and months, rounded."""
    if gap_hours < GAP_DAYS_FROM:
        return f"{gap_hours} hours"

    if gap_hours < GAP_WEEKS_FROM:
        return f"{round(gap_hours / 24)} days"

    if gap_hours < GAP_MONTHS_FROM:
        return f"{round(gap_hours / (7 * 24))} weeks"

    return f"{round(gap_hours / HOURS_PER_MONTH)} months"


def gap_sentence_round_2(gap_hours):
    text = gap_text_round_2(gap_hours)
    return f" This conversation resumed after {text} away."


def iso_text(moment):
    offset = f"{moment:%z}"
    return f"{moment:%Y-%m-%dT%H:%M}{offset[:3]}:{offset[3:]}"


def note(moment, gap_hours=None):
    text = f"[It is {daypart(moment)} on {date_text(moment)}."

    if gap_hours is not None:
        text += gap_sentence(gap_hours)

    return text + "]"


def note_round_2(arm, moment, gap_hours=None):
    if arm in CLOCK_ARMS:
        text = f"[It is {clock_text(moment)} on {date_text(moment)}."

    if arm in ZONE_NAMED_ARMS:
        text = (f"[It is {clock_text(moment)} {moment:%Z} on "
                f"{date_text(moment)}.")

    if arm in WORD_ARMS_ROUND_2:
        text = f"[It is {daypart_round_2(moment)} on {date_text(moment)}."

    if arm in ISO_ARMS:
        text = f"[It is {iso_text(moment)}."

    if gap_hours is not None:
        text += gap_sentence_round_2(gap_hours)

    return text + "]"


def note_for(arm, moment, gap_hours=None):
    if arm in NOTE_ARMS_ROUND_2 or arm in NOTE_ARMS_ROUND_3:
        return note_round_2(arm, moment, gap_hours)

    return note(moment, gap_hours)


def date_line(moment):
    return f"The current date and time: {date_text(moment)}, {daypart(moment)}."


def gap_hours(earlier, later):
    hours = round((later - earlier).total_seconds() / 3600)

    if hours < GAP_HOURS_MIN:
        return None

    return hours


def sender_zone(data, fixture):
    """The zone a fixture's own times are written in."""
    return ZoneInfo(fixture.get("zone") or data["timezone"])


def note_zone(data, fixture, arm):
    """The zone an arm renders its note in."""
    if arm in SENDER_ZONE_ARMS:
        return sender_zone(data, fixture)

    if "host_zone" in data:
        return ZoneInfo(data["host_zone"])

    return ZoneInfo(data["timezone"])


def resume_moment(data, fixture, side):
    return when(fixture["resume"][side], sender_zone(data, fixture))


def key_for(data, fixture, side, arm):
    if "host_zone" in data:
        return zones.key_for(data, fixture, side, arm)

    return "PASSED" if side == "after" else "AHEAD"


def user_times(fixture, zone):
    return [when(turn["at"], zone) for turn in fixture["turns"]
            if turn["role"] == "user"]


def first_seen(fixture, zone):
    """The time a proxy first saw each user message.

    A proxy holds nothing between requests and sees the whole message
    list on each one, so the time it can put on an earlier message is
    the time of the first request that carried it. Every user turn in
    a fixture was its own request, so that is the turn's own send
    time; a message pasted in from elsewhere would get the paste time.
    Round 2 arms stamp from this rule, not from the times as given.
    """
    seen = []
    latest = None

    for turn in fixture["turns"]:
        if turn["role"] != "user":
            continue

        sent = when(turn["at"], zone)

        if latest is None or sent > latest:
            latest = sent

        seen.append(latest)

    return seen


def stamp_times(data, fixture, arm):
    """Each user message's stamp moment, in the arm's note zone."""
    sender = sender_zone(data, fixture)
    shown = note_zone(data, fixture, arm)

    if arm in NOTE_ARMS_ROUND_2 or arm in NOTE_ARMS_ROUND_3:
        return [moment.astimezone(shown)
                for moment in first_seen(fixture, sender)]

    return user_times(fixture, sender)


def system_prompt(data, fixture, arm, stage, resume_at, zone):
    text = data["persona"]
    times = user_times(fixture, zone)

    if arm == "B":
        text += "\n" + date_line(times[0])

    if arm == "B2":
        moment = times[-1] if stage == "warm" else resume_at
        text += "\n" + date_line(moment)

    if arm in NOTE_ARMS:
        text += "\n\n" + EXPLAINER

    if arm in NOTE_ARMS_ROUND_2:
        text += "\n\n" + EXPLAINER_ROUND_2

    if arm in {"ZS", "ZH"}:
        text += "\n\n" + EXPLAINER_ROUND_2

    if arm in {"ZN", "ZO"}:
        text += "\n\n" + EXPLAINER_ROUND_3

    return text


def prior_messages(data, fixture, arm, stage):
    """The scripted turns, stamped the way the arm would have sent them."""
    times = stamp_times(data, fixture, arm)
    messages = []
    seen = 0

    for turn in fixture["turns"]:
        content = turn["content"]

        if turn["role"] == "user":
            moment = times[seen]
            is_last = seen == len(times) - 1
            seen += 1

            if arm in EVERY_MESSAGE_ARMS:
                content = f"{note_for(arm, moment)} {content}"

            if arm in LATEST_ONLY_ARMS:
                if stage == "warm":
                    if is_last:
                        content = f"{note_for(arm, moment)} {content}"

        messages.append({"role": turn["role"], "content": content})

    return messages


def resume_message(data, fixture, arm, text, resume_at):
    times = stamp_times(data, fixture, arm)
    shown = resume_at.astimezone(note_zone(data, fixture, arm))

    if arm in GAP_ARMS:
        gap = gap_hours(times[-1], resume_at)
        text = f"{note_for(arm, shown, gap)} {text}"
        return {"role": "user", "content": text}

    if arm in NOTE_ARMS or arm in NOTE_ARMS_ROUND_2:
        text = f"{note_for(arm, shown)} {text}"

    return {"role": "user", "content": text}


def build(data, fixture, arm, stage, resume_text=None, resume_at=None,
          prior_reply=None):
    """Messages for one request.

    For the resume stage, prior_reply is the model's own answer from
    the warm stage, placed where a real client would place it.
    """
    zone = ZoneInfo(data["timezone"])
    system = system_prompt(data, fixture, arm, stage, resume_at, zone)
    messages = [{"role": "system", "content": system}]
    messages.extend(prior_messages(data, fixture, arm, stage))

    if stage == "resume":
        messages.append({"role": "assistant", "content": prior_reply})
        messages.append(
            resume_message(data, fixture, arm, resume_text, resume_at))

    return messages


def system_changed(data, fixture, arm, resume_at):
    """Whether the system prompt differs between warm and resume."""
    zone = ZoneInfo(data["timezone"])
    warm = system_prompt(data, fixture, arm, "warm", resume_at, zone)
    resume = system_prompt(data, fixture, arm, "resume", resume_at, zone)
    return warm != resume
