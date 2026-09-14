# 0011. Identify a cell by what was requested, not by which build ran it

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

The yuurei version is hashed into `cell_digest` (`src/cell/resolver.ts`), so
every release changes every digest for the same definition — a patch that only
reformats `doctor` output included.

The runtime's own version is not. `CellIdentityInput` carries `runtimeId`, not
the detected version, so upgrading `claude` from 2.1.269 to 2.2.0 leaves cell
identity untouched while a documentation-only yuurei patch changes it.

That asymmetry is the problem. The digest looks like a conservative key — one
that errs toward calling two runs different — but it is strict about the
orchestrator and silent about the agent that actually does the work. It cannot
be defended as "safe", because the largest source of behavioural change is
already outside it.

Two further facts decide the shape of the fix.

Once [ADR-0009](./0009-record-cell-identity-in-the-trace.md) lands, **every
digest input is also recorded as its own field** — `runtime.id`,
`model.requested`, `profile.digest`, `task.digest`, `isolation.strategy`,
`execution_options`, and the yuurei version. The digest is therefore a
convenience key, not the only way to express equivalence: a consumer can compose
any equivalence they need from the fields.

And the trace already has the axis this belongs on. `model.requested` and
`model.resolved` separate what was asked for from what was observed, and the
digest hashes `requestedModel` — the request. The yuurei version is an observed
property of the run, so hashing it mixes an observation into an identity built
from requests.

## Decision

**A cell is identified by what was requested of it.**

- **Remove the yuurei version from `cell_digest`.** It stays recorded as the
  observed field `yuurei_version` (ADR-0009).
- **The runtime version stays out too**, for the same reason, and remains
  recorded as `runtime.version`. What identifies the cell is `runtime.id` — the
  runtime that was asked for.
- Cell identity is: runtime id, requested model, resolved profile content, task
  content, isolation strategy, and the identity-forming execution contracts.
- **Equal digests do not mean the two runs executed under identical
  conditions.** The contract document must say so, and point at the observed
  fields — `yuurei_version`, `runtime.version`, `model.resolved` — as the way to
  tell what actually ran.

While applying this, correct a second inaccuracy in the same formula: §7.3 omits
the isolation strategy, which the implementation has always included and which
`src/cell/types.ts` documents as part of cell identity.

Because §7.3 is normative and these records are not, the change is applied to
the design document itself, carrying the previous wording and the reason.

## Consequences

- Digests compare across yuurei releases. The use case that needs this is real
  but narrow: holding a harness and task fixed over months to see whether the
  model behind a name has drifted — §1's fourth problem, separating model
  differences from harness differences. Every other use in §11 either groups by
  the dimension being varied or compares runs close together in time.
- A naive consumer comparing digests alone can now conclude "same cell" for runs
  that different yuurei builds constructed differently — and yuurei does change
  cell construction (the OpenCode adapter's `XDG_*` redirection, forcing Codex's
  credential store to `file`, closing stdin). **This is a real loss.** It is
  accepted because the same exposure already existed for runtime upgrades, so
  the previous design bought a sense of safety it did not deliver; making the
  boundary explicit and pointing at the observed fields is more honest than a
  key that is conservative about one input and blind to a larger one.
- `inputs_version` is unaffected. It versions the input _set_ — which fields are
  hashed — which is orthogonal to which build did the hashing. The two were
  briefly thought to overlap; they do not.
- Anyone wanting the old strictness composes `(cell_digest, yuurei_version)`.
  The looser default can be narrowed by a consumer; a stricter default could not
  have been widened.
- This changes the digest input set, which is precisely what the v0.3.0
  milestone exists to permit before 1.0. After 1.0 the same change would cost a
  major version.
