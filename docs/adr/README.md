# Architecture Decision Records

Each file here records one decision: the situation that forced it, what was
decided, and what follows from it. Records are append-only. A decision that
stops being true is not edited away — a new record supersedes it, and the old
one keeps its reasoning for whoever asks "why was it ever like that?".

## How this differs from the other documents

Three documents answer three different questions, and each belongs in exactly
one place. Writing the same thing in two of them is how they drift apart.

| Document                            | Question                                 | Time                    |
| ----------------------------------- | ---------------------------------------- | ----------------------- |
| `docs/design/yuurei-design-v0.3.md` | How does the system work?                | Current                 |
| `docs/contract.md`                  | What does the project promise right now? | Current                 |
| `docs/adr/`                         | Why was it decided this way?             | Historical, append-only |

`docs/contract.md` does not exist yet; it is the deliverable of issue #133.
Until it lands, the guarantees described in these records have no authoritative
home, which is one reason that issue blocks the rest of the milestone.

So a guarantee's wording lives in the contract document, not here. What lives
here is the reasoning that produced it, including the alternatives that were
rejected and why.

**An ADR's Decision section is not the authoritative wording of any promise.** It
states what was decided at the time it was written. Where a record quotes a
guarantee it does so to show what was agreed, not to define it. When an ADR and
the contract document disagree, the contract document wins on _what_ is promised
and the ADR still stands as the record of _why_.

### Changing a promise

1. Update `docs/contract.md`. It states the present, so it is edited in place.
2. Add a new ADR recording why the promise changed, and mark the record it
   replaces `Superseded by`.

Never edit an existing ADR to match a new decision. The point of an append-only
log is that the superseded reasoning stays readable.

## Format

```markdown
# NNNN. Title in the imperative

- **Status**: Proposed | Accepted | Superseded by [ADR-NNNN](./NNNN-....md)
- **Date**: YYYY-MM-DD
- **Amended by**: [ADR-NNNN](./NNNN-....md) — one line on what it changes (omit unless amended)

## Context

The forces at play. What made a decision necessary. State the constraint that
actually settled it, not a survey of everything considered.

## Decision

What was decided, in the active voice.

## Consequences

What becomes true, easier, or harder — including the costs accepted. A record
with only upsides in this section is not finished.
```

`Date` is when the record was **written**, which is not always when the decision
was reached. Records 0001–0009 were all written on 2026-09-14 as a backfill of
decisions taken over the preceding planning process; they were not nine decisions
made in one day.

That backfill covers the decisions reached while planning the path to v1. It does
not reach further back: adopting OpenCode as a third runtime, for example, was
decided earlier and is recorded in the design document (§18) rather than here.

Number files sequentially from `0001`, zero-padded to four digits, with a
kebab-case title. Numbers are never reused, including for abandoned records.

`Proposed` means the reasoning is written down but the decision is not settled.
Do not implement against a `Proposed` record.

A record is never edited to match a later decision. Two narrow edits are allowed,
and only these:

- **Adding a pointer** — a `Superseded by` or `Amended by` line, and nothing
  else. Confine it to that line so the exception cannot spread.
- **Correcting a statement that misdescribes the record's own decision** — an
  error, not a revision. A record that says something its decision did not say is
  wrong about itself, and leaving it wrong helps nobody.

Neither covers adopting vocabulary introduced later. When a later record renames
something, earlier records keep the older name; an append-only log is read with
the understanding that older entries use the vocabulary of their time.

## Records

| #                                                       | Title                                                                | Status   |
| ------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| [0001](./0001-v1-means-a-frozen-contract.md)            | v1 means a frozen public contract, not feature completeness          | Accepted |
| [0002](./0002-four-kinds-of-promise.md)                 | Split the public contract into four kinds of promise                 | Accepted |
| [0003](./0003-independent-trace-schema-version.md)      | Version the trace schema independently of the package                | Accepted |
| [0004](./0004-no-repetition-or-comparison.md)           | Keep repetition, comparison and scoring out of yuurei                | Accepted |
| [0005](./0005-keep-credential-bridge-flags.md)          | Keep the credential-bridge flags, with a split guarantee             | Accepted |
| [0006](./0006-level-0-1-isolation-only.md)              | Ship v1 with Level 0–1 isolation only                                | Accepted |
| [0007](./0007-macos-and-linux-only.md)                  | Support macOS and Linux only                                         | Accepted |
| [0008](./0008-trace-records-identity-and-outcome.md)    | The trace records identity and outcome; the manifest records content | Accepted |
| [0009](./0009-record-cell-identity-in-the-trace.md)     | Record cell identity and the digest-input options in the trace       | Accepted |
| [0010](./0010-three-document-split.md)                  | Separate the design document, the contract and these records         | Accepted |
| [0011](./0011-identify-a-cell-by-what-was-requested.md) | Identify a cell by what was requested, not by which build ran it     | Accepted |
| [0012](./0012-versioning-and-deprecation-policy.md)     | State which version bump each kind of promise requires               | Accepted |
| [0013](./0013-resolve-run-parameters-cli-first.md)      | Resolve run parameters CLI-first, and record what the CLI overrode   | Accepted |
