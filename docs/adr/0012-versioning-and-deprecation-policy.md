# 0012. State which version bump each kind of promise requires

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

`CHANGELOG.md` says the project "adheres to Semantic Versioning" and
`docs/releasing.md` says shipped versions are "Semantic Versioning compatible".
Neither says what that means here. SemVer defines major, minor and patch in
terms of "the public API"; it does not say what this project's public API is, so
the declarations answer nothing on their own.

[ADR-0002](./0002-four-kinds-of-promise.md) supplied the missing half by sorting
the contract into four kinds of promise. What remains is the mapping: which bump
does a change to each kind require, what happens before 1.0, and how a removal is
announced.

## Decision

### Before 1.0, the freeze is an intention, not yet a promise

After v0.3.0 the project treats a breaking change to (A) as a **defect**. It does
not promise that no such change will ship before 1.0.

The distinction matters because deciding to freeze a contract and demonstrating
that it can be kept are different acts. v0.3.0 is the decision; the milestone
that exercises the contract against real runtimes is what establishes it holds.
Promising absolute stability from v0.3.0 would leave no room for the one outcome
that verification exists to produce — the discovery that the contract itself is
wrong. Correcting it then, while still on 0.x, is what 0.x is for.

**1.0 is where the project starts making the promise.** Not because exercising a
contract guarantees future compatibility — it cannot — but because committing to
keep a contract that has never been tested against a real runtime would be a
commitment made blind. Verification does not produce the guarantee; it is what
makes offering one defensible.

### Bump per kind of promise, after 1.0

| Kind                                     | Change       | Bump                      |
| ---------------------------------------- | ------------ | ------------------------- |
| **(A)** stable CLI / public data formats | breaking     | **major**                 |
|                                          | additive     | minor                     |
| **(B)** experimental CLI                 | any change   | **minor at least**        |
| **(C)** security invariants              | weakened     | **never, at any version** |
|                                          | strengthened | patch or minor            |
| **(D)** best-effort behaviour            | change       | patch or minor            |

Two entries need their reasoning stated, because both look wrong at a glance.

**A change that strengthens a security invariant ships as a patch or a minor and
is never held back for a major**, even though it can break a user — a tighter
path check may reject a profile that previously worked. `CLAUDE.md` defines a
change that breaks an invariant as a defect, so repairing one is a bugfix, not a
feature, and withholding it until the next major would leave a known hole open
for the length of a major cycle. The user-visible risk goes in the `Security`
section of the changelog entry.

**A change to an experimental surface takes a minor at least**, never a patch,
even though (B) carries no compatibility promise. Declining to promise stability
and removing something silently in a patch are different things.

### Deprecation

Removing something from (A) requires deprecating it in a minor release first and
removing it no earlier than the next major, with at least one minor release of
notice in between.

Notice is given in two places, and the second is the one that reaches people:

- **The changelog entry** — always.
- **A warning at runtime, emitted when the deprecated surface is actually
  used** — required for (A). A changelog reaches whoever reads changelogs; a
  warning reaches whoever is affected. The CLI already has `logger.warn` and
  `loggerForFlags` renders a structured line under `--json`, so this costs little
  per deprecation.

(B) needs only the changelog entry: nothing there was promised, and no
deprecation period is owed.

**One exception, and it is deliberate.**
[ADR-0005](./0005-keep-credential-bridge-flags.md) commits to deprecating the
credential-bridge flags in the minor before removing them, even though they sit
in (B). That commitment was the price of keeping flags with known-unsound
behaviour in a 1.0 product: their CLI shape carries no promise, but users have no
alternative path, so removing one without warning would strand them. The
exception is theirs alone; it does not generalise to (B).

No deprecation obligation applies before 1.0, consistent with the freeze being an
intention until then.

### Changing the cell-digest input set costs a major

After 1.0, changing which inputs feed `cell_digest` is a major change.

What breaks is not the comparison of values.
[ADR-0011](./0011-identify-a-cell-by-what-was-requested.md) removed the yuurei
version from the inputs precisely so that digests survive releases. What breaks
is consumer logic that depends on the documented meaning of cell identity — a
consumer who reads that the timeout does not affect identity, and therefore
varies it while grouping by digest, is wrong the moment the timeout joins the
set. The meaning of an (A) entry changed, so the bump is major.

This is what the v0.3.0 milestone exists to permit: it is the last chance to
change the input set without spending a major version.

### A breaking schema change implies a package major

The trace schema carries its own version
([ADR-0003](./0003-independent-trace-schema-version.md)), but the two are not
independent in both directions. A breaking change to the schema breaks (A)'s
"`trace.json` fields and semantics", so it requires a package major. The reverse
does not hold: a package major implies nothing about the schema.

## Consequences

- "Is this a breaking change?" now has a mechanical answer: find the entry's kind
  in the contract document, read the row.
- A user can be broken by a patch release, when that patch strengthens a security
  invariant. That is accepted deliberately, and is why the changelog's `Security`
  section has to describe the user-visible effect rather than only the fix.
- Every (A) deprecation carries an implementation task — the runtime warning —
  that a changelog-only policy would not. Deprecations in (A) should be rare, so
  the cost is bounded, but it is real and it is charged at exactly the moment the
  project would rather move fast.
- Saying the pre-1.0 freeze is an intention is weaker than a reader may want, and
  someone could treat v0.4.0 as guaranteed-stable and be surprised. The wording
  has to be explicit about this in the contract document rather than left for the
  version number to imply.
- `CHANGELOG.md` and `docs/releasing.md` currently assert SemVer compliance
  without pointing anywhere. Both should reference the contract document once it
  exists (#133), or the policy stays invisible to the people it is written for.
- The pre-1.0 wording has to appear in `docs/contract.md` and the release
  documentation in as many words — "during 0.x, compatibility is an intention
  and not a guarantee". Recording it only in the consequences of a decision
  record leaves it where no user will look, and the version number alone implies
  the opposite to anyone reading 0.4.0 as settled.
