# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/shimpeiws/yuurei/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.1.0
