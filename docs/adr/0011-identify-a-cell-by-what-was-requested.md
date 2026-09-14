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
`model.requested`, `profile.digest`, `task.digest`, `isolation.strategy` and
`execution_options` — and the yuurei version is recorded beside them as an
observed field rather than an input. The digest is therefore a
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
- **Rename it to match what it now means.** `cell_digest` and the heading "cell
  identity" promise the identity of the cell that ran; what is hashed is the
  identity of the cell that was _asked for_. Saying "equal digests do not mean
  identical conditions" does not fix a name that claims otherwise. The digest
  becomes **`requested_cell`** in the trace (`requested_cell.digest`,
  `requested_cell.inputs_version`), `requestedCellDigest` in code, and §7.3
  becomes "Requested cell identity". The vocabulary then matches the axis this
  decision rests on: a reader who understands `model.requested` understands
  `requested_cell` without being told.

  Renaming is free exactly once. The digest has never been persisted — it is
  computed and discarded — so there is no stored field to migrate today, and
  after ADR-0009 starts recording it the same rename would be a breaking schema
  change.

  **Records 0001–0010 and 0012 keep the earlier name `cell_digest`.** They are
  not rewritten: an append-only log is read with the understanding that older
  entries use the vocabulary of their time.

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
- `inputs_version` stays at `1`, but **not** because it is unrelated to this
  change. It versions the input _set_, and this change alters that set, so the
  two are directly related. It stays at `1` because no digest has ever been
  persisted: the first recipe anyone will ever observe is the one defined here,
  so `1` describes a set that never included the yuurei version. Had a digest
  already shipped, this change would have required `2`.
- Anyone wanting the old strictness composes
  `(requested_cell.digest, yuurei_version)`.
  The looser default can be narrowed by a consumer; a stricter default could not
  have been widened.
- This changes the digest input set, which is precisely what the v0.3.0
  milestone exists to permit before 1.0. After 1.0 the same change would cost a
  major version.
