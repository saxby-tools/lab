"""Crude word stems shared by generate.py and check.py.

Compared as strings only: "leak" blocks "leaking" and "leaks", but
"stole" does not block "stolen". FTS5's unicode61 tokenizer does no
stemming at all, so this is stricter than the engine it guards.

Licence: AGPL-3.0-or-later.
"""

import re

WORD_RE = re.compile(r"[a-z]+")

MIN_WORD_LENGTH = 3

SUFFIXES = ("ing", "ies", "ed", "es", "s", "ly")

STOPWORDS = set("""
the and for with that this these those from into onto out over under
about after before again against all any are was were been being
because but can could did does doing done down during each few had
has have having her here hers him his how its itself just let may
might more most much must not nor now off once only other our ours
own same she should some such than then there they them their theirs
through too until very what when where which while who whom why will
would you your yours mine one two three four five six seven eight
nine ten first second next last got get gets getting going went gone
came come comes make made makes making take took taken put say said
says tell told also still yet ever never both either neither per via
around along near behind beside between among within without upon
instead rather quite really well off back away again across
""".split())


def stem(word):
    for suffix in SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= MIN_WORD_LENGTH:
            return word[:-len(suffix)]

    return word


def stems(text):
    words = WORD_RE.findall(text.lower())
    kept = [w for w in words if len(w) >= MIN_WORD_LENGTH]
    kept = [w for w in kept if w not in STOPWORDS]
    return {stem(w) for w in kept}
