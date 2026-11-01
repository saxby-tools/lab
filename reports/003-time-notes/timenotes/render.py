#!/usr/bin/env python3
"""Turn a fixture into the messages each arm would send.

Two stages per resume. The warm stage is the conversation as the arm
sent it on its previous turn: the scripted turns up to the last user
message, which the model then answers for real. The resume stage is
what the arm sends next: the same turns as the arm renders them now,
the model's own reply from the warm stage, and the resume message.
That is what a real client sends, and the only shape whose prefix
this runner takes back from its cache.

    A   nothing
    B   date line in the system prompt from the first message, fixed
    B2  date line in the system prompt, re-rendered every turn
    E   note on the latest user message only
    D   note on every user message, fixed at its own time
    E2  E, plus a gap sentence when an hour or more has passed

Licence: AGPL-3.0-or-later.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

ARMS = ["A", "B", "B2", "E", "D", "E2"]

NOTE_ARMS = {"E", "D", "E2"}

EXPLAINER = (
    "User messages may start with a bracketed note about the current "
    "time, added by the system. Use it. Never write these notes "
    "yourself. If the time or place is unclear and it matters for your "
    "answer, ask."
)

GAP_HOURS_MIN = 1


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


def date_text(moment):
    return f"{moment:%A, %B} {moment.day}, {moment:%Y}"


def note(moment, gap_hours=None):
    text = f"[It is {daypart(moment)} on {date_text(moment)}."

    if gap_hours is not None:
        text += f" This conversation resumed after {gap_hours} hours away."

    return text + "]"


def date_line(moment):
    return f"The current date and time: {date_text(moment)}, {daypart(moment)}."


def gap_hours(earlier, later):
    hours = round((later - earlier).total_seconds() / 3600)

    if hours < GAP_HOURS_MIN:
        return None

    return hours


def user_times(fixture, zone):
    return [when(turn["at"], zone) for turn in fixture["turns"]
            if turn["role"] == "user"]


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

    return text


def prior_messages(fixture, arm, stage, zone):
    """The scripted turns, stamped the way the arm would have sent them."""
    times = user_times(fixture, zone)
    messages = []
    seen = 0

    for turn in fixture["turns"]:
        content = turn["content"]

        if turn["role"] == "user":
            moment = times[seen]
            is_last = seen == len(times) - 1
            seen += 1

            if arm == "D":
                content = f"{note(moment)} {content}"

            if arm in {"E", "E2"}:
                if stage == "warm":
                    if is_last:
                        content = f"{note(moment)} {content}"

        messages.append({"role": turn["role"], "content": content})

    return messages


def resume_message(fixture, arm, text, resume_at, zone):
    times = user_times(fixture, zone)

    if arm in {"E", "D"}:
        text = f"{note(resume_at)} {text}"

    if arm == "E2":
        text = f"{note(resume_at, gap_hours(times[-1], resume_at))} {text}"

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
    messages.extend(prior_messages(fixture, arm, stage, zone))

    if stage == "resume":
        messages.append({"role": "assistant", "content": prior_reply})
        messages.append(
            resume_message(fixture, arm, resume_text, resume_at, zone))

    return messages


def system_changed(data, fixture, arm, resume_at):
    """Whether the system prompt differs between warm and resume."""
    zone = ZoneInfo(data["timezone"])
    warm = system_prompt(data, fixture, arm, "warm", resume_at, zone)
    resume = system_prompt(data, fixture, arm, "resume", resume_at, zone)
    return warm != resume
