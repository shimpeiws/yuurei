# 0018. Pre-register the criterion for dropping OpenCode's experimental marking

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

The OpenCode adapter is marked experimental in the contract (Section B) and in
the user-facing docs. Whether that marking is removed should rest on evidence,
not on how confident the maintainer feels — and the evidence is the real-runtime
end-to-end work this milestone adds (ADR-0017).

The order matters. If the criterion is chosen after the results are in, the bar
moves to fit the outcome, and the marking's removal means whatever the last run
happened to show. The criterion has to be fixed while its answer is still
unknown; then it is applied, and either the marking comes off or the reason it
stays is written down.

The marking is a Section B entry, the kind of promise deliberately outside the
compatibility guarantee. Removing it does not make OpenCode's behaviour more
stable than it is; it makes the statement about its status accurate. The
criterion therefore only has to be enough to say the adapter is not less proven
than the supported runtimes — not to prove OpenCode correct in every respect,
which §20 does not claim.

## Decision

The OpenCode adapter's experimental marking is removed **only when all of the
following hold**, on the release-candidate run against the pinned version
(ADR-0017) on **both macOS and Linux**:

1. A provider-key run produces a valid trace: the run finishes, the trace records
   runtime `opencode`, and it carries a `requested_cell.digest` with its
   `inputs_version`.
2. The config guard refuses a profile `{file:...}` reference that resolves outside
   the cell **before the runtime starts**, so no run directory is produced.
3. A run with no usable credential — neither a forwarded provider key nor a
   bridged auth file — is recorded as a **failure**: a non-zero exit or a failed
   execution in the trace, never a hang and never a reported success.

If any of the three is skipped, or fails for a reason attributable to an upstream
OpenCode change, the marking is **kept**, and the reason is recorded. A partial
pass does not remove it.

Applying the criterion is a change to the contract and the user-facing docs
(`README.md`, `docs/getting-started.md`, `docs/design` §18, §20): the marking is
removed in every place it appears, or a line records why it stays.

## Consequences

- The decision is evidence-based and cannot be rationalised after the fact. A run
  that passes only on Linux, or that never exercises the guard or the no-credential
  path, leaves the marking in place.
- The criterion is deliberately narrow. It does not re-test §20's accepted risks
  (admin-controlled config read outside the cell, its partial credential model);
  those are risks the marking never claimed to cover, and removing the marking
  says the adapter is proven, not that OpenCode is safe in general.
- Checking three scenarios rather than running the whole guide means the marking
  can be removed while some manual sections remain manual. That is consistent:
  the criterion names which checks are sufficient, and the rest stay documented
  with reasons (the automation work in the same milestone).
- Keeping the marking when an upstream change breaks a scenario is the intended
  outcome, not a failure of the exercise: it records that the adapter is not
  currently proven, which is exactly what "experimental" should mean.
- If the criterion is later judged too weak or too strong, the fix is a new
  record that supersedes this one, not an edit — the pre-registration is evidence,
  and rewriting it after the fact would defeat its purpose.
