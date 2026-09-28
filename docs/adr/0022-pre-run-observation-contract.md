# 0022. Pre-run observation contract

- **Status**: Accepted
- **Date**: 2026-09-28
- **Part of**: [#207](https://github.com/shimpeiws/yuurei/issues/207)
- **Coordinated with**: shimpeiws/pfl#211, shimpeiws/gatefold#76

## Context

Issue #207 defines an opt-in observation phase after isolation verification and
before runtime execution. The spike (#209) confirmed that pfl can inspect a
prepared cell's environment (level1 only), but raises several contract questions:

1. The observation must see the _same prepared cell environment_ the runtime will
   see — not the operator's host profile.
2. pfl writes `~/.pfl` inside the cell's HOME under level1; this is residue the
   agent can observe if not removed before execution.
3. Under level0, pfl reads the operator's host `~/.pfl` store, which is a leak
   that must not happen.
4. An observer that is absent, denied, or fails must be recorded as unavailable,
   never interpreted as "no configuration change".
5. Isolation verification failure must still block execution — observation failure
   must not conflated with it.

## Decision

### Ordering

```text
runtime gate → cell/isolation create → materialize → isolation verify → observe/export → execute → collect
```

The observation phase runs _after_ isolation verification (so the observer
executes inside a verified cell) and _after_ materialization (so the observer
sees the actual profile config). An isolation verification failure (exit 4) skips
observation and execution.

**Note**: the current implementation (`src/run/pipeline.ts`) verifies isolation
before materialisation (`createVerifiedIsolation` at L89, then `prepare` at
L256). This ADR deliberately documents a target ordering that differs from the
current code. The implementation reordering is part of #210; the contract
documents the intended final state, not the current intermediate state. Moving
the gate after materialisation ensures the observer sees the materialised profile
while isolation verification still blocks both observation and execution.

### Observation record in trace.json

Add an optional top-level `observation` object:

```jsonc
"observation": {
  "observer": {
    "id": "pfl",                          // observer identifier
    "version": "1.1.0"                    // null when unknown
  },
  "status": "recorded",                   // recorded | partial | unavailable
  "reason": null,                         // present when unavailable
  "completeness": "complete",             // pfl value; null when unknown
  "snapshot_ids": {                       // null when unknown
    "observed": "obs_...",
    "resolved": "res_..."
  },
  "artifacts": [                          // references to retained bytes
    { "path": "observation/export.json", "kind": "observation" },
    { "path": "observation/bundle/harness.json", "kind": "observation" },
    { "path": "observation/bundle/manifest.json", "kind": "observation" }
  ]
}
```

#### Status semantics

| status        | Meaning                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `recorded`    | Observation completed successfully; snapshot IDs and completeness are present.                                              |
| `partial`     | Inspection completed but returned a partial document. `completeness` reflects the pfl value; `snapshot_ids` may be present. |
| `unavailable` | Observation was attempted but could not complete. `reason` is present.                                                      |

An absent `observation` means _not observed / unknown_ — not "no change".
A reader must never treat absence as "the configuration is unchanged".

#### Reason codes (when status = `unavailable`)

| Reason                         | Cause                                                             |
| ------------------------------ | ----------------------------------------------------------------- |
| `observer-not-found`           | pfl binary not on PATH or not installed                           |
| `spawn-failed`                 | pfl subprocess failed to start                                    |
| `timeout`                      | pfl subprocess timed out                                          |
| `consent-required`             | pfl exited 5 (`CONSENT_REQUIRED`); `missingScopes` in diagnostics |
| `export-failed`                | pfl export or bundle write failed after inspection                |
| `isolation-level0-unsupported` | level0: observation not supported in v1                           |

#### Artifact references

`observation.artifacts` lists retained bytes by path. The content (digest,
truncation) is attested in `artifacts.json` (ADR-0008), not in the trace.
Observation artifacts are included in the same `artifacts.json` as other run
artifacts, so `trace.artifacts[]` (which is derived mechanically from the
manifest) also includes them. ADR-0008 is amended to record this: the manifest
attests both runtime-produced and yuurei-retained observation artifacts.

### Retention

Observation artifacts live under `.yuurei/runs/<run-id>/observation/`:

| File                   | Source                                        |
| ---------------------- | --------------------------------------------- |
| `export.json`          | `pfl export --json` (CommandOutcome envelope) |
| `bundle/harness.json`  | `pfl export --bundle` (sanitized IR)          |
| `bundle/manifest.json` | `pfl export --bundle` (evidence metadata)     |

Retention is best-effort. A failure to retain sets `status: unavailable` with
`reason: export-failed` and the run continues — the run directory is not removed.

`--keep` has no effect on observation artifacts: they persist in the run
directory regardless of `--keep`.

### Opt-in surface

`yuurei run --observe` enables the observation phase. Without it, `observation`
is absent from the trace.

- **Section B (experimental)**: the flag's existence, name, and argument shape
  may change or be removed in a minor release.
- **Section A (stable)**: once observation is recorded, the `observation` object
  in `trace.json` is part of the stable surface.

The flag is the only opt-in surface in v1. A `runs.<name>.observe` config key
is not added (it can be added later if operator demand materialises).

### Failure policy

| Condition                                 | observation record                                                          | run continues? |
| ----------------------------------------- | --------------------------------------------------------------------------- | -------------- |
| Isolation verification fails              | (no record; run dir removed; exit 4)                                        | **no**         |
| Observation not opted in                  | field absent from trace                                                     | yes            |
| Observer binary missing / spawn / timeout | `unavailable` + reason                                                      | yes            |
| consent-required (exit 5)                 | `unavailable` + `consent-required`                                          | yes            |
| Partial/failed document                   | `partial` or `unavailable` + completeness/snapshot_ids                      | yes            |
| Export/bundle retention fails             | `unavailable` + `export-failed`                                             | yes            |
| level0                                    | `unavailable` + `isolation-level0-unsupported`                              | yes            |
| Success                                   | `recorded` + snapshot IDs + completeness + observer version + artifact refs | yes            |

Rules:

- The observation record must be **present even on failure** — an absent record
  must never be read as "no configuration change".
- Observer failure never blocks `execute()`. Isolation verification failure
  always blocks both observation and execution.
- Never fall back to inspecting the host when the cell view is unavailable.

### Residue and identity exclusion

The observer must not leave cell-visible residue that alters the environment the
agent runtime will inherit. Under level1, pfl writes `~/.pfl` inside the cell's
HOME; yuurei must remove this directory (or redirect pfl's store) **before**
`runtime.execute()`.

Because observation must not change what the agent can see:

- `observation` and `cell_id` are **not** inputs to `requested_cell.digest`.
- If a future observer cannot guarantee no residue, observation becomes an
  identity input (`inputs_version` incremented). This is the only scenario under
  which observation enters cell identity.

### level0

Under level0, the operator's real HOME is the cell's HOME, so pfl reads the
operator's host `~/.pfl` store — a leak documented in #209. In v1, observation
under level0 is **not supported**:

```
status: "unavailable"
reason: "isolation-level0-unsupported"
```

An alternative (launching the observer with `HOME=<configRoot>` under level0) is
noted for future consideration but deferred.

## Consequences

- A consumer can distinguish "observation was attempted and failed" from
  "observation was never attempted" by checking for the presence of the
  `observation` object.
- The failure policy is simple: one code path for isolation (blocks), one for
  observation (never blocks). No dual-purpose exit codes or mode flags.
- Retention of both `export.json` and `--bundle` is decided: both live under
  `observation/` and are attested in `artifacts.json`. A consumer can choose
  which to use; neither is privileged.
- The `--observe` flag being Section B means its shape may change; the trace
  field being Section A means the data format is stable once shipped.
- Residue removal is a hard requirement, not a best-effort — a failure here is
  a defect, not a tradeoff.
