# 0021. cell_id is the prepared cell's instance identity

- **Status**: Accepted
- **Date**: 2026-09-28

## Context

Issue #207 introduces a pre-run pfl observation phase that must bind its output to
the yuurei run. The yuurei run is already identified by `run_id` (a directory name
regenerated on collision) and `requested_cell.digest` (a hash of the input set).
Neither answers the question "which prepared cell was this observation made from?"

`run_id` is a run-scoped ephemeral identifier. A retry of the same definition
produces a new `run_id` even when the cell contents are identical, so it cannot
identify a prepared cell.

`requested_cell.digest` identifies what was _requested_ of a cell — the input set.
Two prepared cells with the same digest share a request but may differ in their
actual construction (different yuurei versions, different isolation verification
outcomes). An observer that associates itself with a digest cannot distinguish
itself from another observer on the same digest.

What is needed is the identity of the _prepared cell itself_: the directory that
was created, verified, and observed, before the runtime executed inside it.

## Decision

**Introduce `cell_id`: a freshly allocated, opaque identifier for each prepared
isolation cell.**

### Semantics

- One `cell_id` per `createUniqueRunLayout` invocation — a new run always gets a
  new `cell_id`, even when the `requested_cell.digest` is identical.
- `cell_id` is allocated before the observation phase and survives cell disposal.
  It is recorded as a top-level optional field in `trace.json`.
- `cell_id` identifies a _prepared cell_, not the run, not the request, and not
  the observation. A run without observation still carries a `cell_id`.

### Distinction from `run_id`

| Dimension    | `run_id`                | `cell_id`                      | `requested_cell.digest`         |
| ------------ | ----------------------- | ------------------------------ | ------------------------------- |
| Identifies   | The run directory       | The prepared cell              | The input set                   |
| Generated at | `createUniqueRunLayout` | Cell creation (before observe) | Cell resolution (before create) |
| Regenerated  | On collision (EEXIST)   | Never (allocated once)         | Never (input identity)          |
| Per retry    | New                     | New                            | Same                            |
| In trace     | Top-level `run_id`      | Top-level `cell_id` (optional) | `requested_cell.digest`         |

### Format

`cell_<UTC timestamp>-<suffix>` — e.g. `cell_20260928T120000Z-a1b2c3`.

- Starts with a letter, uses only `[A-Za-z0-9._:-]`, 1–128 characters. This
  matches pfl's `--cell-id` validation grammar (pfl#212).
- The `cell_` prefix distinguishes it from `run_id` (which has no prefix) and
  from `requested_cell.digest` (which is `sha256:<hex>`). A reader who sees a
  `cell_` prefix knows it is an instance identity.
- The random suffix avoids collision without providing cryptographic security.
  The ID is not a secret; it is an observation provenance label.

### Transport to pfl

`cell_id` is passed to pfl via `--cell-id` flag on `pfl inspect`. The flag is
the decided transport mechanism (pfl#212); pfl deliberately never persists env
values, so an env transport is rejected.

### Record location

Top-level optional field in `trace.json`:

```jsonc
"cell_id": "cell_20260928T120000Z-a1b2c3"
```

- Absent on traces written before this ADR — a reader treats absence as
  `unknown`, never as `different`.
- `cell_id` is **not** a digest input and does not affect `requested_cell.digest`.
  It is a provenance field alongside `yuurei_version` and `runtime.version`.

## Consequences

- A consumer can correlate a pfl observation (which carries `cell_id` via
  `--cell-id`) with a yuurei run (which carries it in the trace) and with
  retained observation artifacts (which live under `observation/` in the run
  directory).
- Two runs with the same `requested_cell.digest` can be distinguished by their
  `cell_id` when the question is "which prepared cell was this?" rather than
  "what was requested?".
- The `cell_id` is never a substitute for `run_id` or `requested_cell.digest`.
  Each answers a different question and each has its own presence/absence rules.
- Traces from before this change carry no `cell_id`, which obliges readers to
  handle absence as unknown.
