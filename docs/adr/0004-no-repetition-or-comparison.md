# 0004. Keep repetition, comparison and scoring out of yuurei

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

The obvious next feature after "run one cell and record it" is "run it ten times
and compare". Users will ask for `--repeat`, for a model × harness matrix, and
for cost aggregation, and each is a small addition on its own.

§11 assigns exactly those — repeated execution, the comparison matrix, quality
evaluation, cost aggregation, reporting — to a separate upper layer. §18 freezes
that separation and the one-way dependency: the upper layer depends on yuurei,
never the reverse.

So the question is not whether the features are useful. It is whether adding
them here contradicts a decision that is already frozen. It does.

## Decision

**yuurei does not implement repetition, comparison, ranking, scoring or
aggregation.** It isolates, executes, observes and emits a trace.

What it does ship instead is the _seam_ that makes an upper layer possible. This
record fixes the exclusion, not the seam's contents — the specific capabilities
are scoped by the milestone that delivers them, and at the time of writing they
are safe concurrent runs, a machine-readable run index, a complete trace readable
from the CLI, and the run's diff.

## Consequences

- Requests for `--repeat` are answered with the seam, not with the feature.
- The seam becomes load-bearing: if a consumer cannot enumerate runs, read a
  full trace, and obtain a diff through the public CLI, then this decision has
  left users with no path at all rather than a different one.
- yuurei stays small enough to reason about, and stays usable by a consumer that
  wants to do the comparison differently.
- A user who only wants repetition has to write it themselves or wait for the
  upper layer. That cost is accepted.
