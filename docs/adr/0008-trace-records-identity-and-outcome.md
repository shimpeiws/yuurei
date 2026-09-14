# 0008. The trace records identity and outcome; the manifest records content

- **Status**: Accepted
- **Date**: 2026-09-14

## Context

Reconciling §10.1's list of what is recorded against the implemented
`trace.json` turned up three gaps: the yuurei version is absent, `cell_digest`
(§7.3) is absent, and the trace's `artifacts[]` carries `path` and `kind` while
dropping the `digest` that `artifacts.json` holds (`src/run/pipeline.ts` maps the
manifest down deliberately).

A fourth apparent gap — §10.1's "Launch options" having no field — turned out not
to be one. Every launch option except `--keep` is already recorded, distributed
across purpose-named fields (`profile`, `task`, `model`, `isolation`) rather than
gathered under one heading. That is a mismatch between §10.1's phrasing and the
schema's naming, not a missing record. It is settled in
[ADR-0009](./0009-record-cell-identity-in-the-trace.md).

Deciding each gap on its own would produce unrelated answers. They are one
question: **what is the unit of record?**

The current state does not answer it. `trace.json` duplicates the artifact list
from `artifacts.json`, which suggests the trace was meant to stand alone — but
the duplication drops the digest, so it does not. Meanwhile the values that
identify the run at all are in neither file.

The design document is not uniform either: §6.3 calls the trace "a common,
runtime-independent execution record format", singular, while §11 describes the
upper layer as consuming "traces **and** artifacts".

## Decision

**The trace answers "which cell was this, and what happened". The artifact
manifest answers "what did it produce".** Identity and outcome belong in
`trace.json`; content detail belongs in `artifacts.json`.

Apply this as the test for any future field: does it identify the run or state
its outcome, or does it describe the content of something the run produced?

### Applying it to the artifact list

Stated only as "identity and outcome versus content", the principle does not
decide where an artifact's fields go — `path`, `kind` and `digest` can all be
called metadata about an artifact. For the artifact list the principle resolves
into three narrower rules, and it is these that decide the placement:

1. **`trace.artifacts[]` is a projection that shows existence and location.** It
   answers "what did this run produce, and where is it" — nothing about the
   bytes.
2. **`artifacts.json` is the authoritative attestation of content.** The digest
   and the truncation flag live there, and a consumer that needs to verify or
   inspect reads it.
3. **The trace's list is derived mechanically from the manifest**, so the two
   cannot disagree.

So `path` and `kind` are addressing — which product, and where — while `digest`
and `truncated` attest to bytes. A field added later is placed by asking whether
it attests to content: file size does, existence does not.

**What the digest attests to is narrower than it looks.** It covers the artifact
**as stored** — after redaction (§10.2) and any truncation — not the bytes the
runtime originally emitted. The contract document must say so, or the digest
reads as proof of the original output, which it is not.

### Retention is outside the trace's responsibility

`--keep` preserves the temporary cell for debugging. It is not cell identity, and
calling it "not an outcome either" is too quick — it does change something
observable after the run, namely whether that directory still exists.

It is excluded by a separate rule rather than by the identity/outcome test:
**the trace records the run, not how its by-products are retained.** The run
directory persists regardless of `--keep`; what it governs is a debugging
convenience whose lifetime is the operator's business. See
[ADR-0009](./0009-record-cell-identity-in-the-trace.md) for the consequence in
§10.1's wording.

Two properties of the current implementation follow and must be written into the
contract document, because neither is visible from the data alone:

- **`kind` is derived from `path`** (`kindFor` in `src/artifact/collector.ts`
  maps `.diff` to `patch`, `.log` to `log`, everything else to `file`). It
  carries no independent information and is never authoritative — a consumer must
  not treat it as a classification the project promises to keep stable
  independently of the path. It is a convenience that spares every consumer from
  reimplementing the same mapping.
- **The trace's list is projected from the manifest** (`src/run/pipeline.ts`), so
  the two cannot disagree. That guard exists because they once could (#111) and
  must not be removed by a later refactor that builds the list separately.

## Consequences

- The gaps resolve from one test instead of separate judgement calls — see
  [ADR-0009](./0009-record-cell-identity-in-the-trace.md).
- The trace's `artifacts[]` carrying `path` and `kind` without digests stops
  being a lossy copy and becomes the intended split: the trace names what was
  produced, the manifest describes it. No code change is needed there, but the
  contract document has to say the split is deliberate, or the next reader will
  "fix" it.
- A consumer that wants to verify an artifact reads two files. That is the cost
  of not duplicating content into the trace, and it is accepted. The common
  question — what did this run produce? — is still answerable from the trace
  alone, which is why the list is not simply removed.
- The trace keeps a field (`kind`) that is derived rather than independent. The
  alternative, dropping it, would oblige every consumer to reimplement `kindFor`
  from the path. Documenting it as non-authoritative is the cheaper trade.
- This mirrors the test used for `cell_digest` membership — does the option
  change what is executed, or only how the result is stored — so the project has
  one habit for both questions rather than two.
