# Pre-run observation

This document specifies the pre-run observation phase: when it runs, what it
observes, and how failures are recorded.

**Normative source**: the contract is `docs/contract.md`. This document
supplements it with worked examples and the scope matrix.

## Ordering

```text
runtime gate  →  cell/isolation create  →  materialize  →  isolation verify  →  observe/export  →  execute  →  collect
```

The observation phase is opt-in (`--observe`). Without it, `observation` is
absent from the trace and the pipeline proceeds directly from isolation verify
to execution.

### Isolation verification failure

When isolation verification fails (exit 4), observation is skipped entirely.
The run directory is removed and no trace is written.

### Materialisation before observation

The observation must see the same profile config the runtime will inherit.
Materialisation (`runtime.prepare()`) writes the resolved profile's config files
into the cell's config directory before the observer is spawned.

## Scope matrix

What pfl can observe under level1, with `--allow-scope <rt>:user`.
"Observed" means pfl read the file; "opaque" means pfl did not read it;
"denied" means pfl read it under a host-absolute path that does not respect
cell isolation. Yuurei grants only the `user` scope headlessly; `install`
scope is deferred until proven cell-local under level1.

| runtime     | observed                                                                                                | opaque                                                   | denied / limited                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| claude-code | project `CLAUDE.md`; user scope = cell `~/.claude`                                                      | builtin instruction layers                               | version metadata not found (installer metadata is home-relative) |
| codex       | project `AGENTS.md`; user scope = cell `~/.codex` (`config.toml#model` from materialised profile)       | builtin instruction layers                               | version metadata not found                                       |
| opencode    | project `AGENTS.md`; user scope = cell `~/.config/opencode` (`opencode.json` recorded as `unsupported`) | builtin layers, remote-org defaults, managed-preferences | unverified runtime version                                       |

**Consistent limitations under level1**:

- Runtime version detection is degraded: `runtime-version-unknown` / `unverified`
  because installer metadata is home-relative and empty inside the cell.
- Managed scope (`/Library/Application Support/...`) is read under the `user`
  grant and is a host-level location.

**Consent**: with no grants, pfl exits 5 (`CONSENT_REQUIRED`) with
`missingScopes`. `--allow-scope` is honoured headlessly and never persisted.

## Source-project declaration (#214)

A seeded run hands the observer a **declared** source-project identity before
`pfl inspect` runs — needed because a cell's workspace has no `.git`, so pfl
would otherwise derive a `data.project.id` from the temporary cell path and
two observations of the same source project would compare as different
projects.

- The identity is derived at cell resolution from the operator-selected
  `--seed-repo`: `git-<hex16>` over the normalized remote URL (`origin`, else
  the first configured remote, read from the repository-local `.git/config`
  only), or `path-<hex16>` over the canonical source root when the
  repository has no local remote. A `.git` gitdir pointer — a linked
  worktree or submodule — is never followed, matching pfl's consent-gated
  derivation, so a host-side inspection and a prepared-cell observation of
  the same project agree.
- Hand-off: yuurei writes a versioned contract to `<cell>/source-project.json`
  — `{ "version": 1, "issuer": "yuurei", "cell_id", "source_project": { "id",
"kind", "remote"?, "source", "head" } }` — and passes
  `YUUREI_SOURCE_PROJECT_ID` (the identity) and `YUUREI_SOURCE_PROJECT_FILE`
  (the contract path) on the pfl process environment. The observer consumes
  the declaration; it does not read the operator's host Git metadata to
  reconstruct it.
- The contract file is at the cell **root**, never in the workspace: it is
  not part of the seeded baseline or the change record, and it is disposed
  with the cell. Under `--keep` the cell — and with it the declaration —
  is retained for debugging; the file carries only the non-secret
  provenance (`source` path, `head`, `id`) already recorded in the run's
  `trace.json` and `baseline-manifest.json`. The durable record is
  `trace.seed.source_project` and `baseline-manifest.json`.
- An unseeded run declares nothing: no contract file, no env vars, no
  `source_project` in the trace. A missing declaration stays missing — it is
  never substituted with the cell path.
- A declaration that cannot be materialized records
  `status: "unavailable"`, `reason: "source-project-declaration-failed"`.

The declaration is asserted provenance, not observer-verified fact: an equal
identity means "declared the same source project", not "the same bytes were
observed" — the baseline digest, `cell_id` and snapshot IDs still carry
those distinctions.

## Examples

### Success (`status: "recorded"`)

```json
{
  "cell_id": "cell_20260928T120000Z-a1b2",
  "observation": {
    "observer": { "id": "pfl", "version": "1.1.0" },
    "status": "recorded",
    "reason": null,
    "completeness": "complete",
    "snapshot_ids": { "observed": "obs_abc123", "resolved": "res_def456" },
    "artifacts": [
      { "path": "observation/export.json", "kind": "observation" },
      { "path": "observation/bundle/harness.json", "kind": "observation" },
      { "path": "observation/bundle/manifest.json", "kind": "observation" }
    ]
  }
}
```

The run produced an observation with full completeness. Snapshot IDs are present.
Three files were retained under `observation/`.

### Partial (`status: "partial"`)

```json
{
  "observation": {
    "observer": { "id": "pfl", "version": "1.1.0" },
    "status": "partial",
    "reason": null,
    "completeness": "partial",
    "snapshot_ids": { "observed": "obs_xyz789", "resolved": "res_uvw012" },
    "artifacts": [{ "path": "observation/export.json", "kind": "observation" }]
  }
}
```

pfl completed inspection but returned a partial document (e.g. some scopes
unreadable). The export was still retained.

### Observer not found (`status: "unavailable"`)

```json
{
  "observation": {
    "observer": { "id": "pfl", "version": null },
    "status": "unavailable",
    "reason": "observer-not-found",
    "completeness": null,
    "snapshot_ids": null,
    "artifacts": []
  }
}
```

`pfl` was not on PATH. The run continues; no observation artifacts exist.

### Consent denied (`status: "unavailable"`)

```json
{
  "observation": {
    "observer": { "id": "pfl", "version": "1.1.0" },
    "status": "unavailable",
    "reason": "consent-required",
    "completeness": null,
    "snapshot_ids": null,
    "artifacts": []
  }
}
```

pfl exited 5 without `--allow-scope`. The run continues.

### Isolation verification failure (no `observation`)

When isolation verification fails, the run directory is removed and no trace is
written. The `observation` field does not appear — this is distinct from
"unavailable" (which means observation was attempted but failed).

### level0 unsupported (`status: "unavailable"`)

```json
{
  "observation": {
    "observer": { "id": "pfl", "version": "1.1.0" },
    "status": "unavailable",
    "reason": "isolation-level0-unsupported",
    "completeness": null,
    "snapshot_ids": null,
    "artifacts": []
  }
}
```

The operator is running under level0. Observation is not supported in v1.

## Residue handling

pfl writes `~/.pfl` inside the cell's HOME under level1. This is residue the
agent could observe. Yuurei must remove `<cell>/home/.pfl` (or redirect pfl's
store) **before** `runtime.execute()`.

If a future observer cannot guarantee no residue, observation becomes an identity
input and `inputs_version` is incremented. This is stated in the contract as a
hard requirement, not a best-effort.

## Security invariants

- Observation never reads the operator's host configuration.
- Observation never weakens isolation or credentials.
- An observer failure is recorded as unavailable, never silently substituted
  with a host fallback.
- Observation artifacts are bounded by `maxArtifactBytes` and redacted with the
  same credential/secret-pattern pass as logs.
- `cell_id` is not a secret and is never treated as one.
