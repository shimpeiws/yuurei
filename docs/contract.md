# The yuurei public contract

This document states what `yuurei` promises. It is the single normative source:
where another document describes a guarantee, it is summarising this one, and
when the two disagree this one is right.

- **How the system works** is `docs/design/yuurei-design-v0.3.md`.
- **Why a promise is drawn where it is** is `docs/adr/`, an append-only log of
  the decisions. A record there explains reasoning; it never defines a promise.

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

The credential-bridge flags are **not** here; they are in Section B.

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

### `--json` output

One JSON object per line. Every line has `level` (`info`, `warn` or `error`) and
`message`; command-specific fields sit alongside them at the top level. `error`
lines go to stderr, the rest to stdout. Adding a field is an additive change.

### Configuration file schemas

`.yuurei/yuurei.yaml` — `version: 1`, a `profiles` map (`runtime`, `source`), and
a `runs` map (`profile`, `task`). From v0.3.0 a `runs` entry also accepts
`model`, `timeout` and `isolation`.

`profile.yaml` — `runtime`, and an optional `description`.

A named run's `task` path must stay inside `.yuurei/`. A `--task` path given
directly is an explicit operator choice and may point elsewhere.

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

### The run directory

`.yuurei/runs/<run-id>/` contains `trace.json`, `resolved-profile.json`,
`stdout.log`, `stderr.log`, `artifacts.json`, and `patch.diff` and `workspace/`
_(pending #139)_.

`trace.json` is written atomically and last, so its presence means the run
reached its end and the identity-and-outcome record is complete. The **required**
durable outputs are `stdout.log`, `stderr.log`, `artifacts.json`,
`resolved-profile.json` and `trace.json`; their files are present whenever the
run directory is retained, and a failure to write any of them removes the run
directory. Their **content** is not all-or-nothing: the logs are capped and
redacted, so a stored log can be truncated (Section D). Only the workspace copy
and `patch.diff` are additionally best-effort as files: either may be absent or
partial, and the trace's `artifacts` (which files exist) and `diagnostics` (why
one does not) say so.

Two concurrent `yuurei run` invocations never share a run directory: the
directory is claimed atomically and the run id regenerated on collision.

### `patch.diff` and `workspace/` _(pending #139)_

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
`patch.diff`, write `artifacts.json`, write the remaining durable outputs, write
`trace.json` last, then scrub and dispose. If the copy or the patch fails, the run
still succeeds, `patch.diff` is left absent (the patch is not generated from a
partial copy), and the trace records a fixed-string diagnostic. `patch.diff` is
redacted like a log before it is stored, and its digest in `artifacts.json` covers
the stored bytes. The collector caps the stored bytes after redaction;
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

On success it prints the trace. Given a trace written under an older
`schema_version` it reads it **read-only** — never rewriting it, never
recomputing an old digest. Given a run id with no trace it exits 2.

### Run index _(pending #140)_

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

### Supported platforms

macOS and Linux, both exercised in CI _(the macOS matrix is pending #144)_.
Windows is not supported.

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

### OpenCode's experimental marking

The OpenCode adapter is marked experimental. Whether the marking is removed
depends on the end-to-end suite, against a criterion fixed before the suite runs
_(pending #146)_.

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
  beyond the cap the stored bytes are cut and `truncated` is set.

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

No deprecation obligation applies before 1.0, consistent with the freeze being an
intention until then.
