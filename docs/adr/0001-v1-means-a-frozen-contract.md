# 0001. v1 means a frozen public contract, not feature completeness

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

v0.2.0 is published. Deciding what remains before 1.0 requires first deciding
what 1.0 _means_, because the two plausible readings produce different release
plans.

Read as "the feature set is complete", 1.0 waits on Level 2 isolation (§16.3)
and cross-runtime harness portability (§16.1). Both are open design problems
that §18 already froze out of the current scope, so that reading postpones 1.0
indefinitely and makes the version number a statement nobody can act on.

## Decision

**1.0 means the public contract is frozen and the project commits to keeping
it.** It does not mean the feature set is complete.

What ships is a tool whose promises are written down, classified by the kind of
promise each is, and kept.

## Consequences

- Work that changes what the contract covers must land before 1.0. Work that
  only adds capability can land after it. This is what orders the remaining
  milestones.
- 1.0 ships with configuration-level isolation only. That is coherent only
  because the limit is stated plainly where users read it — see
  [ADR-0006](./0006-level-0-1-isolation-only.md).
- The version number stops signalling "this does everything" and starts
  signalling "this will not break you". Some users read 1.0 the first way; the
  documentation has to correct that expectation rather than rely on the number.
- Accepting this means the project cannot later use "but we hadn't finished the
  features" as a reason to break the contract in a minor release.
