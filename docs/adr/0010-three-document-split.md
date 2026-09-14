# 0010. Separate the design document, the contract and these records

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

Reviewing the v1 plan turned up the same defect three times: one guarantee about
the credential-bridge flags was written out in four places, and the reviewer's
verdict was that keeping four copies in sync through a release candidate was not
realistic — whichever copy was edited last would silently become the odd one out.

The cause was not carelessness. There was nowhere obvious for each kind of
statement to live. The design document describes how the system works, so
guarantees drifted into it. Issue bodies needed enough context to be actionable,
so they restated guarantees too. And the reasoning behind a decision had no home
at all — it existed only in the conversation that produced it, which meant the
next person to touch the code would see the rule without the reason and could
only guess whether it still applied.

Introducing this directory without saying what belongs in it would have added a
fourth place for the same text.

## Decision

**Three documents, three questions, and exactly one place a promise is defined.**

| Document           | Question                                 | Time                    |
| ------------------ | ---------------------------------------- | ----------------------- |
| `docs/design/`     | How does the system work?                | Current                 |
| `docs/contract.md` | What does the project promise right now? | Current                 |
| `docs/adr/`        | Why was it decided this way?             | Historical, append-only |

The rule governs _defining_, not _mentioning_. Normative wording lives in
`docs/contract.md` and nowhere else. The design document, these records and issue
bodies may reference or summarize a guarantee — they have to, or none of them
would be readable alone — but none of them defines one. When a summary and the
contract document disagree, the summary is the defect.

Stating this as "no duplication" would be both unachievable and wrong: a design
document that may not describe a guarantee cannot explain the system, and an
issue that may not restate one is not self-contained. What must never be
duplicated is _authority_.

Changing a promise means editing `docs/contract.md` in place — it states the
present — and adding a new record here marking the superseded one. An existing
record is never edited to match a new decision.

## Consequences

- A guarantee has exactly one authoritative wording, so the four-copy problem
  becomes a detectable defect instead of a silent drift.
- It is not prevented by construction, though. Nothing mechanically stops a
  second normative wording from appearing; the split only makes such a wording
  wrong rather than merely ambiguous. Catching one needs a check — a review step,
  or a linter over the documents — and until that exists this decision rests on
  discipline.
- The reasoning behind a decision survives the conversation that produced it,
  including the alternatives rejected — which is what lets a later reader tell a
  deliberate constraint from an accident.
- Three documents is more structure than a solo project strictly needs, and the
  split only pays off if every entry actually lands in one of them. A statement
  that fits none is a signal the split is wrong, not a reason to duplicate it.
- Records written before `docs/contract.md` exists quote guarantees with no
  authoritative home to point at. That is temporary, and it is why issue #133
  blocks the rest of the milestone.
