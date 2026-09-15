# Migrating from 0.x to 1.0

1.0 is the release where the freeze becomes a promise. Until now the contract was
a record of intent; from 1.0 it is the thing a major version protects. The
[contract](contract.md) states what that means for each surface.

Most people have nothing to do: there is no data migration, no config rewrite,
and no renamed command in 1.0 itself. The sections below are for the cases where
it matters.

## Upgrade

```sh
npm install -g yuurei@latest
yuurei doctor
```

`yuurei doctor` reports the runtimes it finds and whether their versions are
supported. The minimums 1.0 exercises are Claude Code `2.0.0`, Codex `0.100.0`
and OpenCode `1.18.0`; the contract's "Runtime detection" section names the exact
versions the release candidate was tested against. Windows is not supported.

To try the candidate before the final tag:

```sh
npm install -g yuurei@next
```

`next` carries the release candidate during the soak. `latest` moves only at the
final tag; a prerelease can never become `latest`.

## What is now frozen

Section A of the contract is the stable surface. From 1.0, a breaking change to
any of it requires a major version; an additive change is a minor.

- Commands: `doctor`, `profile list`, `inspect`, `run`, `runs`, `trace show`,
  `clean`, `init`.
- Flags: the flags in the contract's table, and `--json` on every command listed
  there.
- Per-field parameter resolution — the flag, then the run definition, then the
  default; and `profile`/`task` identify the run rather than act as parameters.
- The exit codes.
- `--json` line shape: one object per line, each with `level` and `message`.
- The configuration file schemas.
- `trace.json`, the requested-cell digest, the run directory layout,
  `patch.diff`, `workspace/`, `artifacts.json`, and `resolved-profile.json`.
- `yuurei trace show`, the run index, runtime detection, and the supported
  platforms.

## What changed for a 0.x user

These landed during 0.3–0.5 and are all part of 1.0. If you last used an earlier
0.x, they are the differences you may notice.

- **`yuurei run` exits 3 when the runtime is not installed or is below its
  minimum**, with no run directory created, and **exits 6 when a required run
  output cannot be saved**. Earlier 0.x reported both as 5. A runtime that _runs_
  and exits non-zero is still not a `yuurei` failure: it is recorded in
  `execution.exit_code` and `yuurei` exits 0.
- **Codex authenticates from `CODEX_API_KEY`.** `codex exec` on current releases
  reads that variable, so the adapter forwards an API key under `CODEX_API_KEY`
  and `OPENAI_API_KEY`. Setting only `OPENAI_API_KEY` still works — the adapter
  maps it — and an empty `CODEX_API_KEY` falls back to it.
- **OpenCode is no longer experimental.** Its adapter passed the release-candidate
  real-runtime check on macOS and Linux, and requires OpenCode `1.18.0` or later.
- **`yuurei runs`** lists the runs under `.yuurei/runs/`, and **`yuurei trace show
--json`** prints the complete trace, so a consumer does not read `trace.json`
  directly to obtain a field.
- **Each run executes in a fresh workspace**, copied after the run into
  `.yuurei/runs/<id>/workspace/` and recorded as an all-additions unified diff in
  `patch.diff`. Both are best-effort, and the trace's `diagnostics` name any
  skipped file with a fixed string and a count, never a path.

## If you consume `trace.json`

The trace schema and the requested-cell digest are now stable, and two rules are
worth building on:

- The digest lives in `requested_cell.digest` and is accompanied by
  `inputs_version` — not `cell_digest`. Compare `inputs_version` first: it names
  the input set the digest covers, and the set can change only in a major.
- A missing digest means **unknown**, not "recompute it". Treat absence as
  absence.
- `truncated` marks a stored record whose bytes were cut at the size cap
  (default 1 MiB). The digest then covers the truncated record, not everything
  the runtime emitted.

## What is still experimental

The credential-bridge flags, `--bridge-codex-auth-file` and
`--bridge-opencode-auth-file`, are Section B: the flag's existence, name and
argument shape may change or be removed in a minor release. While a flag exists,
the contract still promises that the real credential file is never modified and
that the isolated copy is scrubbed on normal exit and catchable signals, even
under `--keep`. A _removal_ is deprecated in the prior minor release first; a
rename or argument change is not.

## During the soak

While the release candidate soaks for one week, `docs/contract.md` is frozen. If
a contract entry changes, the week restarts and the candidate is re-cut. That is
the point of the freeze: the artifact you soaked is the artifact that ships.

If you hit a problem on the candidate, open an issue. A contract-level failure
during the soak is exactly what the period is for.
