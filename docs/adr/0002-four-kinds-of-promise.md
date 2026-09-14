# 0002. Split the public contract into four kinds of promise

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

A single list of "what 1.0 covers" mixes promises that are not the same kind of
thing.

The exit-code table and the `--json` line shape are ordinary compatibility
promises: breaking them is a major version. "Never record a secret in the trace"
(§10.2) is not a compatibility promise at all — it is not something a major
version is allowed to break either. Log redaction is a best-effort text pass
over whatever the runtime happened to emit; promising it as a guarantee would be
promising something the implementation cannot deliver. And what survives a
`SIGKILL` is not a promise in any direction, it is an explanation plus a
recovery path.

Flattening these into one list produces promises the project cannot keep, and
gives no way to answer "is changing this a breaking change?" consistently.

## Decision

**Classify every entry in the public contract into one of four kinds, by the
kind of promise it represents.**

- **(A) Stable CLI and public data formats** — covered by semver; breaking one
  is a major version.
- **(B) Experimental CLI** — publicly reachable, deliberately outside the
  compatibility promise.
- **(C) Security invariants** — absolute. Not weakened by a major version
  either.
- **(D) Best-effort behaviour and explanation** — documented as an expectation
  and a recovery path, never as a guarantee.

Classify by asking what kind of promise the entry is, not by what subsystem it
belongs to.

## Consequences

- "Is this a breaking change?" has one answer per entry, derivable from its
  section.
- An entry can be promoted between sections as its specification settles.
  `patch.diff` sits in (D) until its behaviour is decided, then moves to (A).
- (C) constrains the project more than semver does: a security invariant cannot
  be traded away for a major version bump. That is the intended cost.
- The classification has to be applied to every entry before 1.0, which is
  slower than writing one flat list. The alternative is discovering during the
  release candidate that a promise cannot be kept.
