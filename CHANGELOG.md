# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
What that covers is stated in [the public contract](docs/contract.md).

## [Unreleased]

### Added

- A record under `docs/adr/` and a "Release candidates and the soak" section in
  `docs/releasing.md` settle the 1.0 soak: a candidate is published under the npm
  `next` dist-tag and soaked for one week with `docs/contract.md` frozen, and the
  publish workflow derives the dist-tag from the version so a prerelease can
  never become `latest` (0020).
- `docs/contract-verification.md` maps every contract entry to the test or
  document that demonstrates it, required before the v1.0.0 candidate. Its gaps
  are closed here: `profile list` and `inspect` gain tests, the `--json` line
  shape is asserted, exit 6 is emitted for a required-output save failure, and
  `yuurei run` exits 3 when the runtime is not installed or is below its declared
  minimum (#149).

### Fixed

- `yuurei run` exits 3 (runtime not found or unsupported) instead of 5 when the
  runtime is not installed or is below its minimum, and a failure to save a
  required run output exits 6 (trace or artifact save failed) instead of 5,
  matching the contract's exit-code table (#149).

### Documentation

- `README.md` and `docs/getting-started.md` state plainly that isolation
  separates configuration and environment variables — it is not a container or
  an OS sandbox, and does not confine the code the agent runs — and point at the
  contract for the auth-bridge guarantees instead of restating them (#148).
- `docs/migration-0.x-to-1.0.md` collects what 1.0 changes for a 0.x user: the
  surfaces that are now frozen, the user-visible changes shipped across 0.3–0.5,
  the rules for consuming `trace.json`, and the credential-bridge flags that stay
  experimental (#150).

### Security

- A repo-wide security re-audit for v1.0.0
  (`docs/security/audit-v1-release-candidate.md`). No HIGH findings; every
  Section C invariant holds, the OpenCode adapter was verified against its §20
  contract, and all confirmed fixes from the previous audit remain in place. The
  one MEDIUM item — the Claude Code adapter does not filter `settings.json`
  auth-steering keys — is recorded as an accepted risk under the profile trust
  boundary, not demonstrated exploitable on the supported version (#147).

## [0.5.0] - 2026-09-15

### Added

- The real-runtime end-to-end suite runs in CI. A nightly workflow installs the
  pinned runtime versions and runs the whole suite with the real runtimes
  enabled, on macOS and Linux; a release-candidate workflow does the same and is
  triggered by the `release` label or by hand, as the gate before a tag
  (#143, #145).
- Every section of `docs/manual-verification.md` is labelled automated or
  deliberately manual, with a reason for each manual one (#143).
- CI runs the suite on macOS as well as Linux, so the declared platform support
  and the tested one agree, and each runtime adapter's minimum supported version
  is pinned by a test that fails when the boundary changes without the declared
  value changing with it (#144).
- Two records under `docs/adr/`: the real-runtime end-to-end check is separated
  into a nightly run (a signal to revisit the supported-version boundary) and a
  release-candidate gate (required before the tag), and the criterion for
  dropping OpenCode's experimental marking is fixed before the suite runs
  (0017, 0018). `docs/releasing.md` states that the release-candidate check must
  pass before a release is tagged.
- A record under `docs/adr/` settles the Codex credential path: the supported
  automation credential is an API key forwarded as `CODEX_API_KEY` (with
  `OPENAI_API_KEY` mapped to it), and a ChatGPT access token is deliberately not
  adopted because it rotates, reintroducing the auth-file bridge's mid-run
  refresh problem (0019).

### Changed

- The OpenCode adapter is no longer marked experimental. The criterion fixed
  before the suite ran (ADR-0018) is met: the release-candidate real-runtime
  check passes on macOS and Linux for a provider-key run, the config guard, and a
  no-credential failure (#146).

### Fixed

- The Codex adapter forwards an API key under `CODEX_API_KEY` as well as
  `OPENAI_API_KEY`, because `codex exec` on current releases authenticates only
  from the former and otherwise opens the Responses transport unauthenticated.
  Setting `OPENAI_API_KEY` still works (the adapter maps it), and an empty
  `CODEX_API_KEY` falls back to it (#143, ADR-0019).

## [0.4.0] - 2026-09-15

### Added

- `yuurei runs` lists the runs under `.yuurei/runs/`, with `--json` emitting one
  object per run. A row is a fixed projection of the trace, ordered by ascending
  `run_id`; an unreadable or inconsistent directory is skipped and reported as a
  fixed warning that carries no path (#140).
- `yuurei trace show --json` prints the complete trace, with `level` and
  `message` the only fields beside it, so a consumer does not have to read
  `trace.json` to obtain a field (#141).
- Each run executes in a fresh workspace inside the temporary cell. After the
  run it is copied (no-follow) into `.yuurei/runs/<id>/workspace/`, and
  `patch.diff` records it as an all-additions unified diff. Copy and patch are
  best-effort, and the trace's `diagnostics` name any skipped file with a fixed
  string and a count, never a path (#139).
- Two records under `docs/adr/`: runs are enumerated through a new `yuurei runs`
  command rather than by walking `.yuurei/runs/`, and each cell runs in its run
  workspace with the result recorded as `patch.diff` (0015, 0016).
- `docs/contract.md` now records the run index as a stable surface and
  `patch.diff`/`workspace/` as stable artifacts, naming the base, scope, failure
  and empty-diff behaviour and the accepted risk that a secret the agent writes
  to the workspace is recorded.

### Changed

- The contract states the artifact size cap's default (1 MiB), and the
  concurrent run-directory guarantee is pinned by a regression test (#142).

## [0.3.0] - 2026-09-15

### Added

- `trace.json` records the requested-cell digest and the input set that
  produced it as `requested_cell` (`digest`, `inputs_version`), the observed
  `yuurei_version`, the identity-forming execution contracts as
  `execution_options` (`timeout_ms`, plus an adapter-owned `runtime` record),
  and how the run was specified as `definition` (`run`, `cli_overrides`). All
  four are optional, so older traces still parse and `schema_version` stays
  `0.3` (ADR-0009, ADR-0011, ADR-0013, ADR-0014).
- `runs` entries in `yuurei.yaml` accept `model`, `timeout` and `isolation`.
  The CLI flag overrides the definition per field, and giving a named run
  together with `--profile` or `--task` is now a configuration error rather
  than a silently discarded flag (#136).
- `docs/contract.md`, the normative statement of what the project promises. It
  sorts every entry by the kind of promise it is — a stable surface covered by
  semantic versioning, an experimental surface deliberately outside it, security
  invariants a major release does not license weakening, and best-effort
  behaviour documented so the expectation is accurate — then states which release
  a change to each requires, and how a removal is announced. `CHANGELOG.md`,
  `docs/releasing.md` and `CLAUDE.md` now point at it rather than restating
  guarantees of their own. It takes effect at v0.3.0, and entries describing
  behaviour that lands in that release name the issue implementing them.
- A record under `docs/adr/` settling what the trace schema version is: a
  compatibility token compared for equality, independent of the package version,
  and staying at `0.3` because every pending field addition is optional (0014).
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

- Cell identity is renamed to match what it identifies. The digest is
  `requested_cell.digest` (`computeRequestedCellDigest` in code), the `yuurei`
  version is removed from its input set, and the timeout now joins it, so equal
  digests mean the same thing was _requested_ rather than that two runs
  executed under identical conditions (ADR-0011). The profile name and the task
  path are excluded too, so renaming a profile or moving a task file without
  changing its content no longer changes the digest (ADR-0013). No stored digest
  is invalidated: none was ever persisted.
- `docs/design/yuurei-design-v0.3.md` §6.3 now states how `schema_version` is to
  be compared: it is a compatibility token, matched for equality, never sorted or
  range-compared despite the dotted spelling. It identifies which compatibility
  class a trace belongs to and says nothing about product stability — a 1.0
  product may ship a schema labelled `0.3`, which is the intended result of
  versioning the two independently. The section also records how narrow an
  optional addition's compatibility is: parsing works both ways, but an older
  reader discards fields it does not know, and a feature needing a new field
  simply sees nothing when it is absent.
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

### Fixed

- An unreadable, malformed or schema-invalid `.yuurei/yuurei.yaml`, `profile.yaml`
  or task file now exits `2` (configuration error) instead of `5`, so a bad
  config file is not reported as a runtime failure.
- An execution option whose value is not a JSON value (`undefined`, `NaN`,
  `-0`, a function, a `Map`/`Set`/`Date`/`Buffer`, a class with `toJSON`, or a
  cycle) is rejected as a configuration error rather than letting two distinct
  execution contracts collapse to one digest.
- Digest canonicalization orders object keys by code unit rather than with a
  locale-sensitive comparison, and keeps a literal `__proto__` key, so a digest
  can no longer depend on the machine's locale or collide with an empty object.

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

[Unreleased]: https://github.com/shimpeiws/yuurei/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.5.0
[0.4.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.4.0
[0.3.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.3.0
[0.2.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.2.0
[0.1.0]: https://github.com/shimpeiws/yuurei/releases/tag/v0.1.0
