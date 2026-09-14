# 0006. Ship v1 with Level 0–1 isolation only

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

§9.3 defines four isolation levels. Level 0 swaps the configuration root, Level
1 adds a temporary HOME with restricted environment variables, and Levels 2 and
3 — container/OS sandbox and VM/remote — are Future. The implementation targets
0–1, and §9.3 says plainly that this is configuration-level isolation, **not a
security boundary against malicious code**. §12.1 lists malicious OS operations
by the executing code as explicitly out of scope.

Making Level 2 a 1.0 requirement would postpone 1.0 behind an unsolved design
problem, contradicting [ADR-0001](./0001-v1-means-a-frozen-contract.md).

The real risk is not technical. It is that "isolation" is a word users read as
stronger than it is. Someone who believes yuurei sandboxes an agent will give it
a task they would not otherwise give it.

## Decision

**v1 ships with Level 0–1 isolation.** The `Isolation` interface stays shaped so
a stronger backend can be added later, but no such backend is built for v1.

**Stating the limit in plain language, where users actually read it, is itself a
v1 deliverable** — in the README and the getting-started guide, not only in the
design document. Wording to the effect of: yuurei separates configuration and
environment variables; it does not confine executing code in a container or an
OS sandbox.

## Consequences

- 1.0 is reachable without solving container isolation.
- The project depends on documentation to prevent a misuse that the code does
  not prevent. That is a weaker defence than a sandbox, and it is the trade
  being accepted deliberately.
- Because the limit is stated, a later Level 2 backend is an added capability
  rather than a correction of a false claim.
- Profiles and tasks remain trusted input: once credential bridging is on,
  anything a profile's hooks can run reaches the bridged credential (§9.2). The
  documentation has to say this too, not just the isolation limit.
