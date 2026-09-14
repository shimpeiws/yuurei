# 0005. Keep the credential-bridge flags, with a split guarantee

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

`--bridge-codex-auth-file` and `--bridge-opencode-auth-file` copy the operator's
real `auth.json` into the isolated cell. That file can carry a rotating OAuth
token pair, so if the token refreshes mid-run, the rotated state lands only in
the isolated copy, the real file stays stale, and the rotated copy is discarded
on cleanup. §9.2 explicitly rejects the fix — writing the rotated state back —
because it would modify the operator's global configuration.

Freezing a contract forces the question: is a flag with known-unsound behaviour
kept at 1.0, or removed?

Removal is not cheap. Claude Code has an environment-variable path for a
subscription (`claude setup-token` plus `ANTHROPIC_AUTH_TOKEN`). The Codex
adapter forwards only `OPENAI_API_KEY` (`src/runtime/codex/index.ts`), so
removing the bridge today would leave a ChatGPT-subscription user unable to run
Codex cells at all. That is a loss of capability, not a change of procedure.

Against that: no defect forces removal. The flag is opt-in, off by default,
marked experimental, and its failure mode is documented. The outcome is "the
real login goes stale, log in again" — an availability problem, not a security
one. Keeping an explicitly unstable surface alongside a stable contract is
ordinary practice at 1.0.

The real defect was never the flag. It was describing it as "outside semver"
without saying what that leaves promised.

## Decision

**Keep both flags, and split the guarantee explicitly** rather than exempting
them wholesale.

The split below is recorded to show what was agreed and why it was drawn where
it is. It is not the normative wording — that belongs in `docs/contract.md`,
which distributes these clauses across the four sections of
[ADR-0002](./0002-four-kinds-of-promise.md). Read the contract document for what
is promised today; read this record for why.

- **Not promised**: the flag's existence, name and argument shape. Any of these
  may change or be removed in a minor release.
- **Promised while the flag exists**: the operator's real file is never
  modified; on normal exit and on catchable signals the isolated credential copy
  is scrubbed, including under `--keep`.
- **Promised about identity**: the effective authentication method reaches
  `cell_digest`. The flag's CLI shape is unstable; the fact that it changes cell
  identity is not.
- **Notice**: a _removal_ is preceded by deprecation in the prior minor release.
  Renames, argument changes and behaviour changes carry no notice promise.
- **Stated, not promised**: a mid-run refresh can leave the real login stale.
  The condition and what to do about it are documented.

## Consequences

- A user keeps the only path they have, and knows precisely which part of it may
  move.
- The cleanup promise is bounded to what the implementation can deliver: a
  `SIGKILL` or hard crash bypasses it, and recovery is `yuurei clean`. Promising
  unconditional scrubbing would have been a promise the process cannot keep.
- The project carries a known-unsound surface into 1.0. That is visible rather
  than hidden, which is the point.
- Whether a subscription-derived environment-variable path exists for Codex is
  worth investigating, but it does not gate this decision. If one is found it
  improves the supported path; the bridge stays either way.
