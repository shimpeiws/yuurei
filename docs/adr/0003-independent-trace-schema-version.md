# 0003. Version the trace schema independently of the package

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

`TRACE_SCHEMA_VERSION` is `'0.3'` (`src/trace/schema.ts`), a number inherited
from the design document's own version rather than from anything about the
on-disk format. If the package ships 1.0 while the schema still reads `0.3`,
every consumer has to know the two numbers are unrelated.

Renumbering the schema to match the package is worse: it would imply that a
package release changes the trace format, which is exactly the coupling to
avoid.

Renumbering it to `1.0` immediately is not obviously right either. §6.3 already
states that adding an optional field keeps the version at `0.3`. Choosing a
number before deciding what counts as a major schema change would put the number
and the policy in conflict.

## Decision

**The trace schema carries its own version, unrelated to the package version,
and changes only when the on-disk shape changes.**

**A v1 CLI reads a `0.3` trace read-only.** The project is already published;
there is no reason to make existing traces unreadable. Reading is the only
operation promised — an old trace is never rewritten and an old digest is never
recomputed.

The schema _number_ is deliberately not chosen here. It follows from the
compatibility policy (what is major, what is minor, whether the package version
is also recorded), which is settled separately.

## Consequences

- A consumer can pin against the schema version without tracking package
  releases.
- The independence has to be stated explicitly in the contract document,
  otherwise readers assume the numbers move together.
- Deferring the number means one more decision before the schema work can start.
  Choosing it first would have meant revisiting it once the policy was written.
- Reading old traces read-only obliges the reader to handle absent fields.
  Absent must mean _unknown_, never _different_ — see
  [ADR-0009](./0009-record-cell-identity-in-the-trace.md).
