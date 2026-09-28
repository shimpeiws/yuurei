# Verification contract cards

This document is an index over the normative [public contract](contract.md), not
a second contract. It groups a small set of high-value promises as
**verification propositions** and maps them to the observation points that
currently provide evidence.

The purpose is to review tests by the meaning they protect rather than by
whether they are named unit, integration, or E2E.

A card answers:

- what must remain true;
- what evidence is required to decide it;
- which variation is allowed;
- which outcomes are forbidden;
- where the evidence is observed;
- who owns the meaning of the proposition;
- where a failure should be routed.

## VC-Y-01 — Isolation failure prevents execution

**Verification proposition**

A runtime must not start unless the prepared cell has passed isolation
verification.

**Meaning / background**

Isolation is a precondition for execution. A failure to establish that
precondition is not a runtime failure and must not be collapsed into one.

**Owner**

yuurei isolation contract.

**Source**

[Public contract](contract.md), exit code 4 and isolation guarantees.

**Required evidence**

- isolation verification result;
- runtime-start observation;
- exit status / diagnostic category.

**Allowed variation**

Internal verifier structure, temporary paths, implementation strategy.

**Forbidden**

- runtime starts after failed isolation verification;
- an isolation failure is reported as runtime execution failure;
- a missing verification result is treated as success.

**Observation points**

- integration: `test/integration/isolation-fail-closed.test.ts`;
- system: real-runtime E2E in `.github/workflows/e2e.yml`.

**Failure routing**

Isolation implementation or run-pipeline ordering.

---

## VC-Y-02 — Observation failure is not "no change"

**Verification proposition**

A failed, missing, or partial pre-run observation must never be represented as
a successful observation showing no configuration change.

**Meaning / background**

Absence of evidence is not evidence of absence. Observation status belongs to a
different semantic lane from isolation status and runtime outcome.

**Owner**

yuurei observation contract, coordinated with pfl.

**Source**

[Public contract](contract.md), `observation` record; issues #207, #208, #210.

**Required evidence**

- observation status: recorded / partial / unavailable;
- reason and completeness where available;
- retained observation artifact references;
- runtime execution status kept separately.

**Allowed variation**

Observer diagnostics, snapshot ids, internal subprocess details.

**Forbidden**

- unavailable -> unchanged;
- partial -> complete;
- observer failure -> isolation failure;
- unverified snapshot id -> successful observation.

**Observation points**

- contract / integration coverage for pre-run observation;
- system: `yuurei run --observe` with a real prepared cell.

**Failure routing**

Observation orchestration if the status is wrong; pfl if collection itself
failed; artifact publication if durable evidence is missing.

---

## VC-Y-03 — Cell identity is provenance, not execution equivalence

**Verification proposition**

`cell_id`, `run_id`, and `requested_cell.digest` identify different
things and must remain distinguishable.

**Meaning / background**

A prepared cell instance, a retained run, and a requested input set are not the
same identity. Equal requested-cell digests do not prove equal real execution
conditions.

**Owner**

yuurei trace / cell identity contract.

**Source**

[Public contract](contract.md), `cell_id` and requested-cell sections; issues
#208 and #214.

**Required evidence**

- fresh `cell_id` per prepared cell;
- stable requested-cell digest for equal requested inputs;
- separate run id;
- observer binding to the same prepared cell.

**Allowed variation**

Identifier formatting details that remain within the documented contract.

**Forbidden**

- retry reuses a prepared-cell identity;
- `cell_id` is used as content identity;
- requested digest is presented as proof of observed execution equality.

**Observation points**

- unit: `src/cell/digest.test.ts`, `src/cell/resolver.test.ts`;
- integration: pre-run observation / seeded run tests;
- E2E: requested-cell digest coverage in
  `test/e2e/contract-verification.test.ts`.

**Failure routing**

Identity generation / trace publication / observer hand-off.

---

## VC-Y-04 — Incomplete result evidence is not an empty result

**Verification proposition**

For seeded runs, an absent, truncated, redacted, skipped, or failed result
collection must remain distinguishable from a complete empty diff.

**Meaning / background**

A complete empty diff is positive evidence that no tracked seeded file changed.
An incomplete artifact cannot support that conclusion.

**Owner**

yuurei seeded-run and artifact-completeness contract.

**Source**

[Public contract](contract.md), seeded mode; issue #202.

**Required evidence**

- requested and materialized baseline identity;
- change manifest;
- patch availability and completeness;
- diagnostics for redaction / truncation / omission / failure.

**Allowed variation**

Patch formatting and storage implementation within the public contract.

**Forbidden**

- absent patch -> no change;
- partial patch -> complete;
- omitted file -> unchanged;
- unverified baseline -> valid result comparison.

**Observation points**

- unit: `src/seed/index.test.ts`, `src/run/seeded.test.ts`;
- integration: `test/integration/seeded-workspace.test.ts`.

**Failure routing**

Seed preparation, result collection, redaction, or artifact publication.

---

## VC-Y-05 — Trace provenance reports what was observed, not what was intended

**Verification proposition**

Trace fields must preserve the distinction between requested values and observed
runtime facts.

**Meaning / background**

Requested model, resolved model, runtime version, usage, and cost have different
provenance. Missing observations stay unknown; they do not become zero or the
requested value.

**Owner**

yuurei trace schema and runtime adapters.

**Source**

[Public contract](contract.md), trace / model / usage / cost sections.

**Required evidence**

- requested model and resolved model separately;
- explicit reason when resolved model is unavailable;
- canonical usage fields with null vs absent semantics;
- cost value with source provenance.

**Allowed variation**

Runtime-native aliases during the documented compatibility window.

**Forbidden**

- unreported usage -> zero;
- requested model -> resolved model without evidence;
- estimated cost presented as runtime-reported;
- absent optional field -> "different".

**Observation points**

- unit: `src/trace/schema.test.ts` and runtime adapter tests;
- integration: run-pipeline / trace publication tests;
- system: real-runtime E2E.

**Failure routing**

Runtime adapter, trace normalization, or trace publication.

---

## Initial inventory

- **VC-Y-01:** verifier/pipeline internally, fail-closed integration at the
  boundary, and real-runtime E2E at the system boundary. Coverage is strong.
- **VC-Y-02:** observation status model internally, observer orchestration at
  the boundary, and an observed cell at the system boundary. The semantics are
  strong; the concrete test mapping is indexed below.
- **VC-Y-03:** digest and identifier logic internally, observer hand-off at the
  boundary, and trace plus observed-cell evidence at the system boundary.
  Coverage is strong.
- **VC-Y-04:** seeded result semantics internally and seeded-workspace
  integration at the boundary. Coverage is strong.
- **VC-Y-05:** trace schema and adapters internally, trace publication at the
  boundary, and real-runtime E2E at the system boundary. Coverage is strong.

## Review rule

When changing tests, ask first:

> What verification proposition does this test provide evidence for, and is
> this the cheapest observation point where that proposition is still visible?

A test that protects only an internal call shape should not be promoted to a
semantic contract unless that call shape is itself part of the public promise.
Conversely, system-level evidence should be added where composition, runtime,
OS, filesystem, or process behavior can violate a proposition that inner tests
cannot establish.

## Concrete evidence inventory

The first pass against the current test suite shows that these propositions are
already mostly covered. The main value of this document is therefore indexing
existing evidence, not creating a second test suite.

- **VC-Y-01:** `test/integration/isolation-fail-closed.test.ts` plus the
  real-runtime E2E workflow. Covered at boundary and system levels.
- **VC-Y-02:** `src/trace/schema.test.ts` covers recorded, partial, and
  unavailable observation states. `src/observer/run.test.ts` covers observer
  result parsing and retained export normalization.
  `docs/contract-verification.md` records the expected integration cases for
  missing or denied observers and ordering. Keep that file authoritative for
  the concrete mapping.
- **VC-Y-03:** `src/run/cell-id.test.ts`, `src/cell/digest.test.ts`, trace
  construction in the run pipeline, and requested-cell E2E coverage. Covered
  for local identities; cross-cell stable source identity remains #214.
- **VC-Y-04:** `src/run/seeded.test.ts` and
  `test/integration/seeded-workspace.test.ts`, including the complete empty
  diff case. Covered.
- **VC-Y-05:** `src/trace/schema.test.ts`, runtime adapter tests, and
  `test/integration/run-pipeline.test.ts` for cost, usage, result
  availability, and persisted trace behavior. Covered across normalization and
  publication.

### Gaps / active work

No new standalone verification gap was found in this five-card set.

The open cross-repository gap is already represented by **#214**: stable
source-project identity across independently prepared cells. It extends VC-Y-03
without changing the meaning of `cell_id`, `run_id`, or
`requested_cell.digest`.

### Candidate de-emphasis during future test cleanup

Tests that only pin identifier formatting, helper structure, or adapter call
shape should be treated as maintenance tests unless the corresponding shape is
part of the public contract. They can remain useful, but should not be counted
as independent semantic coverage when deciding whether a proposition is
protected.
