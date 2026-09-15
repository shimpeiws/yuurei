# 0020. Soak a release candidate before 1.0

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

[ADR-0012](./0012-versioning-and-deprecation-policy.md) draws the line between
0.x and 1.0: before 1.0 the freeze is an intention and a breaking change is a
defect; at 1.0 the project starts making the promise. The contract document says
the same — committing to keep a contract never tested against a real runtime
would be a commitment made blind (contract, Scope).

The contract is now tested: v0.5.0 runs the real runtimes in CI, including a
release-candidate check (ADR-0017). But testing the contract is not the same as
soaking the release that will claim it. #149 makes the gap explicit: a release
candidate is only meaningful if the contract stops moving during it. If the
contract document is still being edited while the candidate soaks, the soak
proves nothing about the thing being frozen.

Two things follow, and they are separate. The candidate must be **publishable
without becoming the default** install, so real users can opt in and the stable
`latest` is not disturbed. And there must be a **rule for what a change during
the soak means**, or the freeze is a feeling rather than a state.

## Decision

### Publish the candidate under `next`, never `latest`

The candidate is `1.0.0-rc.1`, published as a GitHub pre-release and to npm under
the **`next`** dist-tag. `latest` stays on the current stable release until
`1.0.0` ships. npm treats `latest` as a direct pointer for a tagless install, so
a prerelease on `latest` would be handed to every new user; the `next` tag is the
conventional opt-in channel (`npm install yuurei@next`), and it is what React,
Vue and others use for the line ahead of `latest`.

The dist-tag is **derived from the version**: a version with a prerelease
component goes to `next`, a clean `X.Y.Z` goes to `latest`. This is one rule with
no special-casing, it keeps `latest` stable by construction, and it extends to a
future `beta` or `rc` without editing the workflow. Publishing a prerelease to
`latest` is never a deliberate act.

### Soak it for one week of real work

The candidate soaks for **one week**, used for real work rather than only for the
automated suite. The period is fixed before the candidate is published, so it
cannot be shortened because the candidate looks fine.

### Freeze the contract during the soak

During the soak, **`docs/contract.md` is frozen**: no change to the requested-cell
digest input set, the `yuurei.yaml` v1 shape, the trace field semantics, or the
exit codes. A change to any contract entry is not a normal iteration — it is the
signal that the candidate is not the thing being frozen, and it **restarts the
one-week period** from the change. The candidate is re-cut if the change is
observable, so the soaked artifact matches the frozen document.

### Every entry is demonstrated before the candidate is published

Publishing the candidate requires that **every contract entry is demonstrated by
a test or a document** (`docs/contract-verification.md`). This is ordered before
the candidate, not after: soaking a contract whose entries are not shown to hold
soaks an untested claim, which is exactly what 1.0 is supposed to stop doing.

## Consequences

- A user can opt in with `npm install yuurei@next`, report a problem, and the
  stable `latest` is unaffected. That is the whole point of a candidate.
- The one-week clock is a formal condition, not a judgement call. Good news
  during the soak does not shorten it; a contract change during it does reset it.
- `1.0.0-rc.1` is immutable once published. If a contract change resets the soak,
  the next candidate is `1.0.0-rc.2`, so the versions in the wild never disagree
  about what was soaked.
- Publishing a candidate is now part of the release machinery
  (`docs/releasing.md`), and the dist-tag rule lives in the publish workflow. A
  review of a release PR can state which checks must pass and which tag the
  artifact will land on.
- The freeze is a discipline, not an enforced constraint. Nothing prevents an
  edit to `docs/contract.md`; the rule is that an edit restarts the soak, and the
  restart is what makes the rule real.

## Addendum: the 1.0.0 soak was waived

- **Date**: 2026-09-16

`1.0.0` was cut from `1.0.0-rc.1` without the full week, by maintainer decision.
It is recorded here and on issue #149 rather than done quietly.

The soak's value is real-world signal, and at the first release there was no user
base to produce any: the candidate's only users were the maintainer and CI, and
CI had already run the real-runtime release-candidate check before the tag.
Nothing in `docs/contract.md` changed between the candidate and the release, so
the artifact that ships is the artifact published as `1.0.0-rc.1` — only the
version and two tense fixes in documents differ.

The rule above is unchanged for a release that has users to draw signal from.
This waiver is specific to the first release, where the condition the rule exists
to satisfy — a candidate used by people other than its author — could not yet be
met.
