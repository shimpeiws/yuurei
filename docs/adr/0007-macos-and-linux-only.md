# 0007. Support macOS and Linux only

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

The supported platforms were never stated. CI runs on `ubuntu-latest` with Node
22 only (`.github/workflows/ci.yml`), while development happens on macOS and
§12.1's OpenCode admin-configuration paths are macOS-specific — so one of the
two platforms the project actually depends on is never exercised.

Windows has never been tested. The isolation design is built on POSIX
assumptions: a temporary HOME, `XDG_*` roots, `TMPDIR`, POSIX permission bits
(`mode & 0o777`), signal semantics for `SIGINT`/`SIGTERM`, and ownership checks
in the orphan sweep.

A platform that CI never runs is not a supported platform, whatever the
documentation says.

## Decision

**macOS and Linux are supported. Windows is not.**

The promise is phrased as what the project can actually keep: _these platforms
are exercised in CI_, rather than an open-ended claim about every environment.

That phrasing carries a second decision, which is recorded here rather than left
implicit: **a declared platform must run in CI.** Today it does not — CI is
Linux-only, so macOS is declared but untested until the matrix lands (#144).
Until then this record describes the target, not the state.

## Consequences

- Once #144 lands, the declared support and the tested support agree, so the
  claim is verifiable by looking at a CI run. Until then the gap is known and
  tracked rather than unnoticed.
- CI cost roughly doubles for the platform matrix. Accepted: an untested
  platform claim is worse than the bill.
- Windows users are told no clearly instead of discovering it through a failure.
- Adding Windows later means revisiting the POSIX assumptions listed above, not
  just adding a CI runner.
