# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A record under `docs/adr/` for how a run's parameters resolve when the CLI and
  the run definition both supply one, and for the `definition` object the trace
  gains so a reader can tell which source won (0013).
- Two further records under `docs/adr/`: cell identity is what was _requested_,
  not which build ran it (0011), and the version bump each kind of promise
  requires, with the deprecation policy (0012).
- `docs/adr/`, an append-only record of the design decisions behind the path to
  v1. Each record carries the context that forced the decision, what was decided,
  and the costs accepted. The directory's README fixes where each kind of
  statement belongs: the design document says how the system works, the contract
  document says what is promised, and these records say why — normative wording
  lives in exactly one of them.

### Changed

- `docs/design/yuurei-design-v0.3.md` §7.3 is now "Requested cell identity", and
  the digest it defines is `requested_cell_digest` — recorded as
  `requested_cell.digest`. The former name, `cell_digest`, promised the identity
  of the cell that ran while what it hashes is the cell that was _asked for_; a
  name that claims more than it delivers is not repaired by a note saying so.
  Nothing has ever persisted the value, so the rename costs nothing now and
  would be a breaking schema change once it is recorded.
- `docs/design/yuurei-design-v0.3.md` §7.3 redefines cell identity as **what was
  requested of a cell**, and corrects two errors in the same formula. The
  `yuurei` version is no longer part of it: hashing it meant every release — a
  patch touching only documentation included — produced a different digest for
  the same definition, while the runtime's own version was never hashed, so
  upgrading the coding agent left identity unchanged. The version is now recorded
  as an observed property instead, so equal digests mean the same thing was
  _requested_, not that two runs executed identically — read the `yuurei`
  version, the runtime version and the resolved model to see what actually ran.
  The isolation strategy is added to the formula, which had omitted it although
  the implementation always included it. The code still hashes the version; it
  follows in the release that implements this.
- `docs/design/yuurei-design-v0.3.md` §10.1 narrows two recording promises to
  what the trace actually carries, with the previous wording and the reasons kept
  in place. "Launch options" becomes the execution contracts that constitute cell
  identity: most launch options were already recorded under their own names, and
  the residue — `--keep` — is deliberately not recorded, because retention is
  outside the trace's responsibility. "List of artifacts and their digests"
  becomes the artifacts a run produced and where they are; `artifacts.json`
  stays authoritative for the digest, which covers the bytes **as stored**, after
  redaction and any truncation, rather than what the runtime originally emitted.
  §10.1 also now lists the cell digest, which §7.3 defines but §10.1 omitted.

## [0.2.0] - 2026-09-14

### Added

- An experimental OpenCode runtime adapter (issue #106). It runs
  `opencode run --format json --auto` inside the isolated cell, redirects every
  OpenCode root (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`, `TMPDIR`) into the cell, disables project-config and
  external-skill loading, and normalizes `step_finish` usage into the trace.
  Minimum supported version: 1.18.0. Listed alongside Claude Code and Codex in
  the user-facing docs as an experimental runtime, after implementation and the
  required security review
  (`docs/security/reviews/opencode-adapter-2026-09-14.md`).
- `yuurei run --bridge-opencode-auth-file`: experimental, opt-in reuse of the
  real `~/.local/share/opencode/auth.json` (off by default; the supported path
  is forwarding a provider API key from the environment).
- `trace.json` gains two additive, optional fields: `model.resolved_reason`
  (`observed` / `unobserved` / `parse_failed`) and `diagnostics` (durable,
  secret-free normalization notes). `schema_version` stays `0.3`; older traces
  remain readable.
- A root `SKILL.md`, so a coding agent can install yuurei as a skill
  (`npx skills add shimpeiws/yuurei`) and discover the shortest path, the output
  format, the exit codes, and the credential constraint on its own.
- `AGENTS.md`, a short pointer to `CLAUDE.md` so non-Claude agents read the same
  project rules without a second copy.

### Changed

- The README documents the exit-code table and the `npx skills add` command.

### Security

- The OpenCode adapter rejects any profile-supplied `{file:...}` config
  reference that resolves outside the isolated cell — including the operator's
  real credential store under level0 — before the runtime starts, and rejects a
  literal provider `apiKey` (which would otherwise persist under `--keep`).
  Path resolution fails closed on permission and symlink-loop errors and when
  `HOME` is unset (so a `~` reference is never expanded to a path the runtime
  would not actually read), and JSON config is inspected on decoded values so
  string escapes cannot hide either shape.
- OpenCode normalization persists only fixed-string `diagnostics`; runtime
  output such as an error event's name or message is never written to the
  trace.

## [0.1.0] - 2026-09-13

First published release. It implements the v0.3 design scope: single-runtime
"native cell" execution for Claude Code and Codex.

### Added

- `yuurei init` scaffolds a project (`.yuurei/yuurei.yaml`, one profile, one
  task). It never overwrites existing files and creates no credentials.
- `yuurei run` executes a named run, or a `--profile`/`--task` pair, inside a
  temporary execution cell built for that run. `--keep` preserves the isolated
  config and logs for debugging; `--bridge-codex-auth-file` opts in to reusing
  an existing `~/.codex/auth.json`.
- `yuurei doctor` reports runtime installation, version support, and whether an
  explicit credential is available, with runtime-specific next steps. It also
  reports temp directories orphaned by abnormal termination.
- `yuurei clean` removes those orphaned directories.
- `yuurei profile list` and `yuurei inspect <profile>` show the resolved
  configuration without starting a runtime.
- `yuurei trace show <run-id>` reads back a run's trace.
- Runtime adapters for Claude Code and Codex, each materializing runtime-native
  config into the isolated cell without reading or mutating the operator's
  global configuration.
- Level 0 and Level 1 isolation, verified before the runtime starts; execution
  is refused when isolation cannot be verified.
- A runtime-agnostic `trace.json` per run, plus `stdout.log`, `stderr.log`,
  `artifacts.json`, and `resolved-profile.json` under `.yuurei/runs/<run-id>/`.
  The trace records identity and outcome, never profile content or secrets.

### Changed

- `yuurei --version` reads the version from `package.json` instead of a
  hardcoded value; the manifest is now the single source of truth.
- `engines.node` is aligned with the Node.js version exercised in CI
  (`>=22.0.0`).
- Added a reproducible npm publish workflow using GitHub OIDC trusted
  publishing.

### Fixed

- The npm `bin` entry keeps the `yuurei` executable when publishing.

### Security

- Credential material written during setup is registered with the pipeline as
  it is written, so it is scrubbed on every exit path — including a signal
  delivered mid-preparation under `--keep`.
- Profile config may not supply a runtime's own credential path
  (`.credentials.json` for Claude Code, `auth.json` for Codex); the guard
  compares on the resolved destination.
- `resolved-profile.json` records per-file digests, modes, and sizes rather
  than profile content, so a profile's own secrets never reach the run
  directory.
- The orphan temp-dir sweep skips non-directories, symlinks, and directories
  owned by another user.
- `trace.json` is written atomically and last, so it is a reliable completion
  marker and can never be read half-written.

[Unreleased]: https://github.com/shimpeiws/yuurei/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.2.0
[0.1.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.1.0
