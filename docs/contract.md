# The yuurei public contract

This document states what `yuurei` promises. It is the single normative source:
where another document describes a guarantee, it is summarising this one, and
when the two disagree this one is right.

- **How the system works** is `docs/design/yuurei-design-v0.3.md`.
- **Why a promise is drawn where it is** is `docs/adr/`, an append-only log of
  the decisions. A record there explains reasoning; it never defines a promise.
- **What demonstrates each entry** is `docs/contract-verification.md`: a test or
  a document for every entry, required before the v1.0.0 release candidate.

## Scope

This contract takes effect at **v0.3.0**. Some entries describe behaviour that
lands in that release and is not implemented yet; each such entry names the
issue that implements it. An entry with no such note describes shipped
behaviour.

**Before 1.0, the freeze is an intention, not a promise.** From v0.3.0 a
breaking change to a Section A entry is treated as a defect. The project does
not promise that none will ship before 1.0: verifying the contract against real
runtimes may reveal that the contract itself is wrong, and correcting it while
still on 0.x is what 0.x is for. **1.0 is where the project starts making the
promise** — not because verification guarantees future compatibility, which it
cannot, but because committing to keep a contract never tested against a real
runtime would be a commitment made blind.

## The four kinds of promise

Entries are sorted by the _kind_ of promise they are, because they are not all
the same kind and a flat list produces promises that cannot be kept.

| Section                      | What it means                                                          |
| ---------------------------- | ---------------------------------------------------------------------- |
| **A. Stable surface**        | Covered by semantic versioning. Breaking one is a major release.       |
| **B. Experimental surface**  | Publicly reachable and deliberately outside the compatibility promise. |
| **C. Security invariants**   | Absolute. Not weakened by a major release either.                      |
| **D. Best-effort behaviour** | Documented expectations and recovery paths, never guarantees.          |

---

## A. Stable surface

### Commands

`yuurei doctor`, `yuurei profile list`, `yuurei inspect <profile-name>`,
`yuurei run [run-name]`, `yuurei runs`, `yuurei trace show <run-id>`,
`yuurei clean`, `yuurei init [directory]`.

### Flags

| Command                                                                                        | Flags                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `init`                                                                                         | `--runtime`, `--profile`, `--task`, `--run`                            |
| `run`                                                                                          | `--profile`, `--task`, `--model`, `--keep`, `--timeout`, `--isolation` |
| all of the above, plus `doctor` / `profile list` / `inspect` / `runs` / `trace show` / `clean` | `--json`                                                               |

The credential-bridge flags and `--seed-repo` are **not** here; they are in
Section B.

### Resolution of a run's parameters

Per field, in this order: the CLI flag if given, then the run definition's entry,
then the default. Per field and not per record — passing `--model` does not
discard a `timeout` the definition set.

`profile` and `task` identify _which run_ this is and are not parameters. Giving
a named run together with `--profile` or `--task` is a configuration error
(exit 2), not an override.

A value set in the run definition cannot be unset from the CLI. It can be
changed; `--timeout 2147483647` is the practical maximum; and
`yuurei run --profile P --task T` inherits nothing.

### Exit codes

| Code | Meaning                                    |
| ---: | ------------------------------------------ |
|    0 | Execution succeeded                        |
|    2 | Configuration error                        |
|    3 | Runtime not found or unsupported           |
|    4 | Isolation verification failed              |
|    5 | Runtime execution failed                   |
|    6 | Trace or artifact save failed              |
|  130 | Interrupted by `SIGINT` (shell convention) |
|  143 | Terminated by `SIGTERM` (shell convention) |

Code 3 is a runtime that is not installed, or is below its declared supported
minimum: the run does not start and no run directory is created. Code 5 is the
CLI's mapping for a failure that is none of configuration (2), runtime support
(3), isolation (4), or a save failure (6). A runtime that **runs** and exits
non-zero is not a `yuurei` failure: it is recorded in `execution.exit_code` and
`yuurei` exits 0 (design §12.2).

### `--json` output

One JSON object per line. Every line has `level` (`info`, `warn` or `error`) and
`message`; command-specific fields sit alongside them at the top level. `error`
lines go to stderr, the rest to stdout. Adding a field is an additive change.

### `--json` error codes

Every `error` line carries a stable `code` and the `exit_code` beside `level`
and `message`. The `code`, not the prose `message`, is the contract: an agent
branches on it to decide retry / fix config / authenticate / give up, and the
message stays free to change. Each code names a distinct failure an agent must
be able to tell apart without reading `message`. The initial vocabulary is:

| `code`                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `no_project`          | No `.yuurei/` directory was found from the working directory.        |
| `unknown_run`         | The named run is not defined in `yuurei.yaml`.                       |
| `unknown_profile`     | The named profile is not defined in `yuurei.yaml`.                   |
| `unknown_runtime`     | A runtime id is not one of the supported adapters.                   |
| `runtime_unavailable` | A supported runtime is not installed or is below its minimum.        |
| `invalid_config`      | A configuration file or profile is unreadable, malformed, or unsafe. |
| `invalid_input`       | A CLI argument or run parameter has an invalid value.                |
| `task_path_escapes`   | A named run's task path would escape `.yuurei/`.                     |
| `no_trace`            | No trace exists for the requested run id.                            |
| `isolation_failed`    | Isolation verification failed (fail closed).                         |
| `save_failed`         | A required run output could not be saved.                            |
| `internal_error`      | An unexpected failure with no more specific code.                    |

Adding a code is additive; changing or removing one is a breaking change to
this Section A surface.

### Configuration file schemas

`.yuurei/yuurei.yaml` — `version: 1`, a `profiles` map (`runtime`, `source`), and
a `runs` map (`profile`, `task`). From v0.3.0 a `runs` entry also accepts
`model`, `timeout` and `isolation`; `seed_repo` is accepted as the named-run
form of the Section B `--seed-repo` flag and shares its experimental status.

`profile.yaml` — `runtime`, and an optional `description`.

A named run's `task` path must stay inside `.yuurei/`. A `--task` path given
directly is an explicit operator choice and may point elsewhere.

`--task -` reads the task from standard input instead of a file, for a caller
that already holds the task as a string. The task's content forms cell identity,
so the digest is over the same bytes and matches a file holding that content; a
task with no path records `task.source` as `stdin`. The content is passed to the
runtime as a positional argument, so a task larger than the platform's
argument-size limit cannot run either way.

### `trace.json`

The fields and their meanings. `schema_version` is a **compatibility token,
compared for equality** — it is not a range, carries no ordering, and must never
be sorted or compared with `<` or `>` despite the dotted spelling. It identifies
which compatibility class a trace belongs to, and says nothing about product
stability, release maturity, or whether incompatibilities have occurred in the
past. It is independent of the package version, so a 1.0 product ships a schema
labelled `0.3`.

An optional field added later does not change the compatibility class. What that
preserves is narrow: **parsing** works in both directions. It does not preserve
data — an older reader discards fields it does not know — and it promises nothing
about a feature that needs a new field, which sees nothing when the field is
absent.

A reader must treat an **absent** field as _unknown_, never as _different_.

Fields landing in v0.3.0: `requested_cell` (`digest`, `inputs_version`),
`yuurei_version`, `execution_options`, `definition` (`run`, `cli_overrides`).

Fields added after v0.3.0 (additive, optional): `cell_id`, `observation`
(`observer`, `status`, `reason`, `completeness`, `snapshot_ids`, `artifacts`),
`seed.source_project` (`id`, `kind`, `remote`).

`usage` carries a canonical vocabulary every adapter maps its runtime's own
field names onto, so two runtimes express the same quantity under the same
key:

- `input_tokens` — input (prompt) tokens, as the runtime accounts them.
- `output_tokens` — output (completion) tokens.
- `cache_read_input_tokens` — input tokens served from the runtime's cache.
- `cache_write_input_tokens` — input tokens written into the runtime's cache.
- `reasoning_output_tokens` — output tokens the runtime attributes to
  reasoning or thinking.

The mapping is adapter-owned: Claude Code's `cache_creation_input_tokens` is
recorded under `cache_write_input_tokens` and its `thinking_tokens` under
`reasoning_output_tokens`; Codex's `cached_input_tokens` under
`cache_read_input_tokens`. A quantity the runtime does not report is `null`,
never zero, and one the adapter never attempts is absent. A trace written
before this vocabulary existed carries the runtimes' own key names instead.

Consumers may already read those runtime names, and the vocabulary lands
without a trace-schema bump, so the trace keeps emitting them as **deprecated
aliases** until the next major: Codex writes `cached_input_tokens` alongside
`cache_read_input_tokens`; Claude Code writes `cache_creation_input_tokens`
alongside `cache_write_input_tokens`; OpenCode writes `cost_usd` alongside the
`cost` fragment. An alias carries the same value — and the same `null` — as its
canonical key, so a 0.3 consumer that reads it keeps working; a new adapter does
not add one, and all of them are removed in the next major.

`cost` is `null` or `{ amount, currency, source }`. `source` identifies where
the figure came from, so a later recomputation knows what it is looking at:
`runtime` when the runtime itself reported it (Claude Code's
`total_cost_usd`, OpenCode's per-step `cost`), otherwise the id of the
`CostModel` that produced the estimate. A runtime-reported cost is the
provider's own number for the run, not an estimate. `source` is additive:
a trace written before it existed carries `{ amount, currency }` alone, and
a reader treats its absence as unknown.

`model.resolved` is the model the runtime reports having served, which is not
necessarily the model that was requested. Where the runtime's output exposes
the identity it is recorded; Claude Code's result object carries a
`modelUsage` map keyed by the serving model id, and several ids mean several
models served the run (a fallback, for example) and are joined. When
`resolved` is `null`, `resolved_reason` says why: `unobserved` means the
runtime's output carries no model identity — Codex's and OpenCode's event
streams emit none — and `parse_failed` means a source existed but could not
be read.

### The requested-cell digest

`requested_cell.digest` identifies **what was requested of a cell**: the runtime
id, the requested model, the resolved profile content, the task content, the
isolation strategy, and the identity-forming execution contracts.

A profile's **name** and a task's **path** are provenance, recorded in the trace
but not part of the digest. Renaming a profile or moving a task file without
changing its content does not change the digest.

**Equal digests do not mean two runs executed under identical conditions.** They
mean the same thing was requested. To see what actually ran, read the observed
fields: `yuurei_version`, `runtime.version` and `model.resolved`.

Comparability is decided by `requested_cell.inputs_version`, never by the digest
value: two digests carrying different `inputs_version` are never compared, even
when equal. An old digest is never recomputed.

Whether an option belongs to the input set is decided by one question — changing
it, with the same profile, task and model, _could_ it change the permitted
behaviour, the termination condition, the environment, the inputs, the outputs
or the side effects? `timeout` is a yes; `--keep`, which changes only retention,
is a no.

### `cell_id`

`cell_id` identifies the **prepared cell instance**: the directory that was
created, verified, and observed, before the runtime executed inside it. It is
distinct from `run_id` (a run-scoped directory name) and
`requested_cell.digest` (a hash of the input set).

- Format: `cell_<UTC timestamp>-<suffix>` — e.g. `cell_20260928T120000Z-a1b2`.
- One per `createUniqueRunLayout` invocation. A retry of the same definition
  produces a new `cell_id`.
- Transported to pfl via `--cell-id` flag.
- Optional in the trace: absent on older runs, treated as unknown.

See ADR-0021.

### `seed.source_project`

A seeded run's **declared source-project identity** (#214): derived from the
selected `--seed-repo` repository, stable across cells prepared from the same
source, and never derived from the temporary cell's workspace path. It is what
lets two real observed cells of one project be recognized as the same project.

- `id` is `git-<hex16>` over the repository's normalized remote URL —
  `origin` if configured, else the first remote, read from the
  repository-local `.git/config` only (global/system Git configuration and
  `include` directives are not consulted, and a `.git` gitdir pointer of a
  linked worktree or submodule is never followed); the equivalent spellings
  `ssh://git@github.com/o/r.git`, `git@github.com:o/r.git` and
  `https://github.com/o/r` normalize to `github.com/o/r` — or, for a
  repository with no local remote, `path-<hex16>` over the canonical source
  root.
- `kind` names the derivation (`git-remote` or `local-path`); `remote`
  carries the normalized URL and is present only for `git-remote`.
- The derivation matches the observer's own project identity, so a host-side
  `pfl inspect` and a prepared-cell observation of the same project carry
  the same id.
- It is **declared provenance**: yuurei asserts it; the observer does not
  independently verify it. It is not an input to `requested_cell.digest`,
  and equal ids do not imply identical observations or executions —
  `cell_id`, `run_id` and the pfl snapshot IDs remain distinct per run.
- An unseeded run has no source project: `seed` (and with it
  `source_project`) is absent, and a consumer must treat that as "no
  declared identity" — never substitute the cell-local workspace path or any
  other value as a comparison identity.

The same identity and its provenance (`source`, `head`) are recorded in
`baseline-manifest.json` and handed to the observer — see "Source-project
declaration" under Pre-run observation.

### `observation`

`observation` records the result of a pre-run pfl observation phase, when
`--observe` is given. See "Pre-run observation" below for the full contract.

Optional in the trace: absent when observation is not opted in, treated as
unknown. When present, `status` is one of `recorded`, `partial`, or
`unavailable`. An absent `observation` must never be interpreted as "no
configuration change".

### The run directory

`.yuurei/runs/<run-id>/` contains `trace.json`, `resolved-profile.json`,
`stdout.log`, `stderr.log`, `artifacts.json`, `patch.diff`, `result.txt` and
`workspace/`. A run seeded with `--seed-repo` additionally contains
`baseline-manifest.json` and `changes.json` — see Section B. A run with
`--observe` may additionally contain `observation/` — see "Pre-run observation"
below.

`trace.json` is written atomically and last, so its presence means the run
reached its end and the identity-and-outcome record is complete. The **required**
durable outputs are `stdout.log`, `stderr.log`, `artifacts.json`,
`resolved-profile.json` and `trace.json`; their files are present whenever the
run directory is retained, and a failure to write any of them removes the run
directory. Their **content** is not all-or-nothing: the logs are capped and
redacted, so a stored log can be truncated (Section D). Only the workspace copy
and `patch.diff` are additionally best-effort as files: either may be absent or
partial, and the trace's `artifacts` (which files exist) and `diagnostics` (why
one does not) say so. `result.txt` is best-effort the same way.

Two concurrent `yuurei run` invocations never share a run directory: the
directory is claimed atomically and the run id regenerated on collision.

### `patch.diff` and `workspace/`

This section describes an **empty-workspace run**. A run seeded with
`--seed-repo` retains and diffs differently; its semantics are defined under
the flag in Section B.

The runtime executes in a fresh workspace **inside the temporary cell**. After
the run, the pipeline copies its regular files into `workspace/` in the run
directory (no-follow: symlinks are not followed or copied) and generates
`patch.diff` from that copy. The copy preserves content only; mode, executable
bit, owner and mtime are not promised. Nothing is copied into the cell workspace,
so every file is a new file and the diff is an all-additions diff.

`patch.diff` is a UTF-8, LF-terminated unified diff, with files in ascending
order of the UTF-8 byte sequence of their relative path: one hunk per non-empty
file, with `--- /dev/null` and `+++ <path>` headers (path relative to the
workspace root, forward slashes), each content line prefixed with `+`, and a
`\ No newline at end of file` marker where the stored file lacks a trailing
newline. An empty file is represented by its headers alone, with no hunk. A CRLF
is not normalized; a trailing CR stays in the line content.

A file is skipped, and stays in `workspace/` with only the patch omitting it,
when it contains a NUL byte or invalid UTF-8, when a component of its relative
path is not valid UTF-8 or contains a NUL, LF, CR, TAB or backslash, or when it is
larger than the effective artifact size cap (`maxArtifactBytes`). Files are added
until the next would take the whole patch past that cap; the rest are skipped.
Every skip is recorded in the trace's `diagnostics`; the strings are fixed, the
count is the only variable for a skip, and a failure is a fixed sentence with no
count. No path is ever included:

- `workspace: <n> symlink(s) skipped`
- `workspace: <n> special file(s) skipped`
- `workspace: copy failed; durable workspace may be incomplete`
- `patch: <n> binary file(s) omitted`
- `patch: <n> oversized file(s) omitted`
- `patch: <n> unrepresentable name(s) omitted`
- `patch: <n> file(s) omitted over the total cap`
- `patch: generation failed; patch.diff not recorded`

A skip category with no entries is omitted; a failure sentence appears only when
the failure occurred.

`patch.diff` is created whenever generation succeeds; with no in-scope files it is
an empty file, so a missing `patch.diff` always means generation did not succeed.
Copy and patch generation are best-effort, and run in this order before the
isolation cell is disposed: copy the cell workspace, generate and redact
`patch.diff`, persist `result.txt`, write `artifacts.json`, write the remaining
durable outputs, write `trace.json` last, then scrub and dispose. If the copy
or the patch fails, the run still succeeds, `patch.diff` is left absent (the
patch is not generated from a partial copy), and the trace records a
fixed-string diagnostic. `patch.diff` is redacted like a log before it is
stored, and its digest in `artifacts.json` covers the stored bytes. The collector caps the stored bytes after redaction;
`truncated: true` means it cut them at the cap, so the stored bytes are not a
complete unified diff.
The patch is not a round-trippable snapshot: it does not represent mode,
executable bit, owner, mtime, or empty directories. A filesystem actor mutating
the tree during the copy, and a hard link to an inode outside the workspace, are
out of scope (§12.1), as they are for profile materialization.

The files in `workspace/` are stored **as the agent produced them and are not
scrubbed**; a secret the agent writes there is recorded. This is an accepted
risk, not a guarantee. `workspace/` is not an entry in `artifacts.json`.

`--keep` preserves the isolation cell only; `workspace/` and `patch.diff` persist
in the run directory regardless.

### `result.txt`

`result.txt` is the runtime's final assistant message, read out of the
structured output the adapter already parses (the `result` field for Claude
Code, the last `agent_message` item for Codex, the last `text` event for
OpenCode). It is runtime output, so it is never inlined into `trace.json`: it
is stored as a file, redacted and capped like a log, and listed in
`artifacts.json` with `kind: "result"`.

Persisting it is best-effort like `patch.diff`. When no `result.txt` exists the
trace's `diagnostics` says why, as a fixed string with no runtime text:

- `result: no final message emitted` — the runtime's output ended without a
  final message (or no output was captured at all).
- `result: final message could not be parsed` — a source existed but could not
  be read into text.
- `result: save failed; result.txt not recorded` — persistence itself failed.

### `artifacts.json`

Each entry carries `path`, `kind`, `digest` and an optional `truncated`.

- `digest` covers the artifact **as stored** — after redaction and any
  truncation — not the bytes the runtime emitted.
- `truncated` true means the stored bytes were cut at the size cap.
- An artifact **absent** from the manifest was not collected; it does not mean
  the run produced nothing.
- `kind` is derived from `path` and is never authoritative. A consumer must not
  treat it as a classification kept stable independently of the path.

The trace names what a run produced and where it is; `artifacts.json` is
authoritative for every property of the stored bytes.

### `resolved-profile.json`

Records the profile's identity rather than its content: the name, the profile
digest, the `profile.yaml` contents, and per-file digests, modes and sizes for
the materialized config. Profile content is never written here.

### `trace show`

On success it prints the trace. With `--json` the printed line carries the whole
trace: every field of `trace.json` is present at the top level, beside `level`
and `message`, so a consumer does not read the file to obtain a field. Without
`--json` the output is a human-readable summary and its shape is not a promise.
Given a trace written under an older `schema_version` it reads it **read-only** —
never rewriting it, never recomputing an old digest. Given a run id with no trace
it exits 2.

### Run index

`yuurei runs` lists the runs under the current project's `.yuurei/runs/`. With
`--json` it emits one object per run, one per line; rows are the `info` lines
carrying a `run_id`.

A row is a fixed projection of the run's trace and carries exactly `run_id`,
`started_at`, `finished_at`, `runtime.id`, `model.requested`, `profile.name`,
`task.source`, `isolation.strategy`, `execution` (`exit_code`, `signal`,
`timed_out`), and `requested_cell` (`digest`, `inputs_version`). Field names and
nesting match the trace. Each nested object carries only the listed field
(`runtime` is `{ "id": ... }`, `model` is `{ "requested": ... }`, `execution` is
`{ "exit_code", "signal", "timed_out" }`, `requested_cell` is
`{ "digest", "inputs_version" }`). The row is closed: a trace field outside this
list does not appear, and extending the list is an additive change. A field
absent from the trace is **absent** from the row, never `null`, and an absent
optional object is not emitted as an empty object.

Rows are ordered by ascending lexicographic `run_id`. A directory under
`.yuurei/runs/` is skipped when its `trace.json` is missing or does not parse, or
when its name does not equal the trace's `run_id`; only directories are
considered. Skipped directories are reported as one fixed `warn` line,
`runs: <n> invalid run director(ies) skipped`, never with a directory name, the
run id, or the parse error text. The human-readable form is a summary and is not
part of this promise.

### Runtime detection

Which runtimes are recognised, and the minimum supported version of each. The
promise is that **these versions are exercised in CI** — not that every future
runtime version will work.

The exercised set is installed at an exact version by the nightly and
release-candidate workflows (ADR-0017): `@anthropic-ai/claude-code@2.1.272`,
`@openai/codex@0.154.0`, `opencode-ai@1.18.31`, each at or above the adapter's
declared minimum. Moving the exercised set is an edit to that workflow; the
minimum boundary itself is pinned by a test.

### Supported platforms

macOS and Linux, both exercised in CI. Windows is not supported.

### Pre-run observation

**Ordering**: when `--observe` is given, the observation phase runs after
materialisation and isolation verification, and before runtime execution.
The full ordering is: cell create → materialise → verify (fail-closed) →
observe → execute. An isolation verification failure (exit 4) skips
observation and execution. See design `docs/design/pre-run-observation.md`
for the ordering diagram and scope matrix.

**Opt-in**: `--observe` on `yuurei run`. Without it, `observation` is absent
from the trace (see Section B for the flag's stability status).

**Status**: one of `recorded`, `partial`, or `unavailable`. When `unavailable`,
`reason` is one of: `observer-not-found`, `spawn-failed`, `timeout`,
`consent-required`, `inspect-failed`, `export-failed`,
`isolation-level0-unsupported`, `residue-removal-failed`,
`source-project-declaration-failed`. See ADR-0022
for the full failure policy table.

**Retention**: observation artifacts live under `observation/` in the run
directory. The observer runs `pfl inspect` (creates a snapshot) then
`pfl export --out <dir> --bundle <dir>/bundle` (produces sanitized IR and
evidence bundle). pfl's `<snapshot-id>.json` output is normalised to
`export.json`; `bundle/harness.json` and `bundle/manifest.json` are kept as-is.
All retained files are redacted with the same credential/secret-pattern pass as
logs and bounded by `maxArtifactBytes`. Content is attested in `artifacts.json`
with `kind: observation`. Retention of individual files is best-effort; a
failure sets `status: unavailable` with `reason: export-failed` and the run
continues. `observation/` is not a required output — its absence does not
remove the run directory.

**Residue**: pfl writes `~/.pfl` inside the cell's HOME under level1. Yuurei
removes this directory **before** `runtime.execute()`. This is a hard
requirement — residue that alters the agent-visible environment is a defect.
Removal failure aborts the run (exit 4).

**level0**: observation under level0 is not supported in v1 (`status:
unavailable`, `reason: isolation-level0-unsupported`). The operator's host
HOME is shared, and pfl reads the host `~/.pfl` store, which is a leak.

**Source-project declaration** (#214): on a seeded run, before spawning the
observer yuurei materializes a versioned contract file at the cell root —
`<cell>/source-project.json`, shaped
`{ "version": 1, "issuer": "yuurei", "cell_id", "source_project": { "id",
"kind", "remote"?, "source", "head" } }` — and exposes the declaration to the
pfl process as `YUUREI_SOURCE_PROJECT_ID` (the identity) and
`YUUREI_SOURCE_PROJECT_FILE` (the contract's absolute path). Both are
yuurei-asserted declarations the observer may consume; the observer never
reads the operator's host Git metadata or configuration to reconstruct them.
The file sits outside the cell workspace — it is never part of the seeded
baseline or the change record — and is disposed with the cell. A declaration
that cannot be materialized records `status: unavailable` with
`reason: source-project-declaration-failed`.

**Identity exclusion**: observation is **not** an input to
`requested_cell.digest`. If a future observer cannot guarantee no residue,
observation becomes an identity input (`inputs_version` incremented). This is
stated in ADR-0022 as a hard requirement.

---

## B. Experimental surface

Publicly reachable, deliberately outside the compatibility promise.

### `--bridge-codex-auth-file` and `--bridge-opencode-auth-file`

**Not promised**: the flag's existence, name or argument shape. Any of these may
change or be removed in a minor release.

**Promised while the flag exists**:

- The operator's real credential file is never modified. _(Also Section C.)_
- On normal exit and on catchable signals the isolated credential copy is
  scrubbed, including under `--keep`. _(Also Section C.)_
- The effective authentication method reaches `requested_cell.digest`. The CLI
  shape is unstable; that it changes cell identity is not.

**Notice**: a _removal_ is preceded by deprecation in the prior minor release.
This is a deliberate exception to Section B's general rule, and it does not
generalise: the flags are kept despite known-unsound behaviour, and users have
no alternative path, so removing one without warning would strand them. Renames,
argument changes and behaviour changes carry no notice promise.

**Stated, not promised**: a credential refresh during a run can leave the real
login stale, requiring a fresh login. See Section D.

### `--seed-repo`

Seeds the cell workspace from one explicitly selected project root instead of
starting empty — the coding-task shape (#202). Also settable on a run
definition as `seed_repo`, resolved against the project root (the directory
holding `.yuurei/`).

**Not promised**: the flag's existence, name or argument shape. It may change
or be removed in a minor release.

**Promised while the flag exists**:

- **Input.** Exactly one local Git repository root, in a clean tracked state.
  Nothing is cloned or fetched, and the source repository is never modified.
  A subdirectory of a repository, a non-repository path, an unborn HEAD, or a
  dirty tracked state (staged, unstaged or deleted tracked files) is a
  configuration error — the runtime is not started.
- **What is seeded.** Only regular files tracked by Git, at content verified
  against the index. Untracked files, ignored files, `.git/` and `.yuurei/`
  are never seeded; the policy is recorded as `git-tracked-files` in
  `trace.seed.policy` and `baseline-manifest.json`. A tracked symlink,
  submodule (gitlink), unresolved index stage, unsafe path, or tracked path
  that is not a regular file on disk fails closed before the runtime starts,
  as does exceeding a documented limit: 20,000 files, 8 MiB per file, 128 MiB
  total.
- **Baseline identity.** The seed is reduced to a canonical path-and-content
  manifest and a whole-baseline digest. `baseline-manifest.json` records that
  manifest, the requested and materialized baseline digests, the source path
  and Git HEAD — non-secret provenance only. The materialized workspace is
  verified against the requested baseline before the runtime starts; a
  mismatch is a configuration error.
- **Source-project identity.** The run declares a stable identity for the
  selected repository — `trace.seed.source_project` and
  `baseline-manifest.json` record `id`, `kind` and, for `git-remote`, the
  normalized `remote`. See `seed.source_project` in Section A for the
  derivation and semantics.
- **Cell identity.** Seed mode and the baseline digest join the requested-cell
  input set: a seeded run carries `requested_cell.inputs_version` 2, an
  unseeded run keeps 1. An old digest is never recomputed (Section A).
- **Result record.** After the run, `workspace/` retains only files whose
  content differs from the baseline — added and modified files, as produced.
  `changes.json` records the added, modified and deleted paths, bound to the
  baseline digest. `trace.seed` records the policy, the provenance, both
  baseline digests, the file and byte counts, and the change counts (the
  `changes` object is absent when collection did not complete). The recorded
  change set is by content digest; mode, owner and mtime differences are not
  part of it.
- **Patch and completeness.** `patch.diff` is a unified diff relative to the
  baseline: an addition keeps the `--- /dev/null` / `+++ <path>` headers, a
  deletion emits `--- <path>` / `+++ /dev/null` with a removal hunk, and a
  modification emits a single hunk replacing every old line with every new
  one. Baseline bytes for modified and deleted files are re-read from the
  source repository and verified against the manifest; content that no longer
  verifies is omitted with the fixed diagnostic
  `patch: <n> file(s) omitted; baseline content unavailable`. `trace.patch`
  records `base` (`seeded`, or `empty` on a run with no seed) and `state`:
  `complete` (the stored diff describes every recorded change), `partial`
  (redacted, truncated, or one or more omitted files), or `absent` (no
  `patch.diff` was produced). A complete **empty** diff — a successful
  no-change run — is distinct from an absent patch, and an incomplete record
  is never reported `complete`.

**Notice**: same rule as the credential-bridge flags — a removal is preceded
by deprecation in the prior minor release.

### `--observe`

Enables the pre-run pfl observation phase. See "Pre-run observation" in Section A
for the full contract, retention, failure policy, and residue requirements.

**Not promised**: the flag's existence, name or argument shape. Any of these may
change or be removed in a minor release.

**Promised while the flag exists**:

- The operator's real global configuration is never read by the observer.
  _(Also Section C.)_
- Observation failure never blocks runtime execution.
- Observation is never an input to `requested_cell.digest`.

---

## C. Security invariants

Absolute. A major release does not license weakening one. Strengthening one
ships as a patch or minor and is never held back for a major, because a change
that breaks an invariant is a defect and withholding its repair leaves a known
hole open for a major cycle. The user-visible effect of such a change is
described in the changelog's `Security` section.

- **The operator's real global configuration is never renamed, moved or
  deleted**, and the credential-bridge flags never modify the real credential
  file.
- **Secrets are never recorded in `trace.json`.** This is distinct from log
  redaction, which is best-effort — see Section D.
- **Credentials are never copied into a profile.**
- **A profile cannot redirect authentication to the operator's shared OS
  credential store.** The adapter forces the credential-storage backend at the
  highest-precedence layer available, whatever a materialized profile asks for.
- **The runtime is not started when isolation verification fails.**
- **A failed credential bridge leaves the run unauthenticated** and never treats
  it as authenticated. This is deliberate, and is not the same as failing open.
- **Credential material written to disk is scrubbed on cleanup, including under
  `--keep`**, on normal exit and on catchable signals (`SIGINT`, `SIGTERM`).
  `SIGKILL` and hard crashes are outside this — see Section D.
- **Path validation, isolation verification and credential bridging fail
  closed.** A failure never falls back to "allow".
- **Pre-run observation never reads the operator's host configuration, never
  weakens isolation or credentials, and an observer failure is recorded as
  unavailable, never silently substituted with a host fallback.**

---

## D. Best-effort behaviour

Documented so the expectation is accurate. None of it is a guarantee.

- **Log redaction.** `stdout.log` and `stderr.log` have known credential values
  and secret-shaped patterns removed before they are persisted. This is a text
  pass over whatever the runtime emitted, not a content-aware guarantee.
- **After `SIGKILL` or a hard crash**, a temporary cell can survive, including
  credential material. `yuurei doctor` reports orphaned directories and
  `yuurei clean` removes them.
- **Credential staleness.** With a bridge flag, a token refresh during a run
  lands only in the isolated copy; the real file stays as it was and the rotated
  copy is discarded on cleanup. The real login may then need to be re-established.
- **Secrets in `workspace/`.** The files under `workspace/` are stored as the
  agent produced them and are not scrubbed; only `patch.diff` receives the
  best-effort text redaction. See Section A.
- **Artifact size cap and log truncation.** Stored artifacts and logs are capped;
  the cap defaults to 1 MiB (`DEFAULT_ARTIFACT_MAX_BYTES`). Beyond the cap the
  stored bytes are cut and `truncated` is set, so the digest covers a truncated
  record rather than everything the runtime emitted.

---

## Not covered

- Human-readable output formatting (`doctor` and the rest). Only `--json` is
  covered.
- The TypeScript interfaces `Runtime`, `Isolation`, `TraceSchema` and
  `CostModel`. They are internal; nothing is exported as a library API.
- Everything §12.1 of the design document places out of scope, including
  malicious OS operations by the code under execution, vulnerabilities in the
  runtimes themselves, network attacks, and process- or filesystem-level
  isolation. **Isolation here is at the configuration and environment level. It
  does not confine executing code in a container or an OS sandbox.**

---

## Versioning

| Section | Change       | Release                           |
| ------- | ------------ | --------------------------------- |
| **A**   | breaking     | **major**                         |
| **A**   | additive     | minor                             |
| **B**   | any change   | **minor at least**, never a patch |
| **C**   | weakened     | **never, at any version**         |
| **C**   | strengthened | patch or minor                    |
| **D**   | any change   | patch or minor                    |

Two further rules:

- **Changing the requested-cell input set after 1.0 is a major release.** What
  breaks is not the comparison of values but the documented meaning consumers
  build on: someone who reads that the timeout does not affect identity, and
  varies it while grouping by digest, is wrong the moment it joins the set.
- **A breaking trace schema change implies a package major.** The reverse does
  not hold — a package major implies nothing about the schema.

## Deprecation

Removing something from Section A requires deprecating it in a minor release
first, removing it no earlier than the next major, with at least one minor
release of notice in between.

Notice is given twice, and the second is the one that reaches people:

- **The changelog entry** — always.
- **A warning at runtime, emitted when the deprecated surface is used** — for
  Section A. A changelog reaches whoever reads changelogs; a warning reaches
  whoever is affected.

Section B needs only the changelog entry, with the one exception named there.

No deprecation obligation applied before 1.0, consistent with the freeze being an
intention until then.
