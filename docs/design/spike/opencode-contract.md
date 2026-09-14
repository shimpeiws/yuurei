# OpenCode adapter contract spike (issue #106)

Read-only contract investigation run before any adapter code. The reusable
script is [`scripts/spike/opencode-contract.sh`](../../../scripts/spike/opencode-contract.sh).

- **Date:** 2026-09-14
- **Host:** macOS Darwin 25.5.0, arm64
- **OpenCode versions tested:**
  - `1.18.30` (Homebrew, `/opt/homebrew/bin/opencode`) — current
  - `1.18.0` (GitHub release `opencode-darwin-arm64.zip`) — proposed floor
- **Method:** every invocation ran with a throwaway `HOME`, `XDG_*`, and
  `TMPDIR` under `$TMPDIR`, against a decoy "real home" carrying sentinel
  values. The operator's real config was never used as an input and never
  written. Findings below are identical on 1.18.0 and 1.18.30 unless noted.

## 1. Non-interactive entry point

`opencode run [message..]` is the stable non-interactive entry point.

```
opencode run --format json --auto [-m provider/model] [--pure] <task>
```

- `--format json` streams newline-delimited JSON (NDJSON) events to stdout.
- `-m/--model` takes `provider/model` (e.g. `openrouter/anthropic/claude-3.5-haiku`).
- `--auto` auto-approves permissions that are not explicitly denied. Without it
  (and without a TTY) OpenCode auto-rejects permission requests, so a coding
  task cannot proceed.
- `--dir <path>` changes the run directory; the adapter does not need it
  because `execCapture` already spawns with `cwd = isolation.rootDir`.
- stdin: `execCapture` spawns with `stdio: ['ignore','pipe','pipe']`, so the
  child's stdin is at EOF immediately. OpenCode's
  `const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()`
  returns an empty string rather than hanging. **No stdin hang.**
- `--version` prints a bare semver (`1.18.30`), so `isVersionAtLeast` parses it.
- Both 1.18.0 and 1.18.30 expose `--format`, `--model`, `--auto`, `--dir`,
  `--pure`.

## 2. Paths (`opencode debug paths`)

With `HOME`, all four `XDG_*` vars, and `TMPDIR` pointed at the cell, every
path resolves inside the cell:

| root   | isolated (cell)                 |
| ------ | ------------------------------- |
| home   | `$HOME`                         |
| data   | `$XDG_DATA_HOME/opencode`       |
| config | `$XDG_CONFIG_HOME/opencode`     |
| state  | `$XDG_STATE_HOME/opencode`      |
| cache  | `$XDG_CACHE_HOME/opencode`      |
| bin    | `$XDG_CACHE_HOME/opencode/bin`  |
| log    | `$XDG_DATA_HOME/opencode/log`   |
| repos  | `$XDG_DATA_HOME/opencode/repos` |
| tmp    | `$TMPDIR/opencode`              |

With `HOME` set but `XDG_*`/`TMPDIR` unset, all roots fall back under `$HOME`,
**except `tmp`, which resolves to the fixed `/tmp/opencode`** regardless of
`HOME`. Two consequences for the adapter:

- **`TMPDIR` must be set to a cell directory.** This is a real path redirection
  the adapter owns; it is not implied by `HOME` or `XDG`.
- **Level 0 keeps the operator's real `HOME`**, so the adapter must set
  `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`
  (and `TMPDIR`) explicitly at the adapter layer — the OpenCode analog of
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Relying on `HOME` alone is not enough.

## 3. Isolation / leak probes

| Probe                                                   | Result                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Global config (`decoy ~/.config/opencode`)              | isolated: not read (0 hits); HOME-only: read (1 hit)                   |
| Project config from `cwd` (`opencode.json`)             | read by default (1 hit); `OPENCODE_DISABLE_PROJECT_CONFIG=1` → 0       |
| External skills `~/.claude/skills` + `~/.agents/skills` | imported by default (2 hits); `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` → 0 |
| `{file:~/.local/share/opencode/auth.json}` in config    | **resolved and read the decoy credential** (1 hit)                     |

Notes:

- `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` suppresses both `~/.claude` and
  `~/.agents` scans. `OPENCODE_DISABLE_CLAUDE_CODE=1` suppresses only the
  `~/.claude` scan. The adapter should set the broader
  `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` so level 0 cannot import the operator's
  personal skills.
- Config supports `{env:VAR}` and `{file:path}` substitution, where `file`
  paths may be relative to the declaring config, absolute, or `~/`. The
  `{file:...}` probe confirms a profile-supplied config can read an arbitrary
  path — including the operator's real credential store under level 0. A
  **profile-materialization-boundary guard is required** (see §7).

## 4. Output protocol and usage

`step_finish` carries usage. Example keys from a real run (values redacted):

```
type=step_start  part.type=step-start
type=text        part.type=text
type=step_finish part.type=step-finish
  part.tokens = {total,input,output,reasoning,cache:{read,write}}
  part.cost   = 0
```

- Distinct emitted event types observed: `step_start`, `text`, `step_finish`,
  and (on failure) `error`. Tool/reasoning events (`tool_use`, `reasoning`) are
  emitted for runs that use those features.
- **Model identity is not emitted in JSON mode** (only `part.tokens`/`cost`),
  so `model.resolved` cannot be observed from stdout. It must be recorded as
  `null` with an explicit unobserved reason.
- Unknown/missing usage fields must be treated as _unknown_, not zero.

**Free provider.** With no credentials at all, `opencode run` still succeeded
(`exit_code: 0`, `cost: 0`, e.g. `input=6174, output=16, cache.read=1792`) via a
free default provider. So `authUsable` is not simply "a credential exists" —
OpenCode can run unauthenticated. `doctor` should report credential presence,
not treat its absence as "cannot run".

**Auth failure.** Forcing a model that requires credentials with none available
yielded `exit_code: 1`, a single stdout `error` event
(`{"name":"UnknownError","data":{"message":"Unexpected server error. ..."}}`),
and **empty stderr**. Auth failures therefore surface via exit code + stdout
event, not a clean message.

## 5. Env vars

Observed / relevant (`opencode` 1.18.x):

- Paths: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`, `TMPDIR`.
- Isolation-relevant toggles: `OPENCODE_DISABLE_PROJECT_CONFIG`,
  `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE`,
  `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_PURE`, `OPENCODE_DISABLE_MODELS_FETCH`.
- Config injection: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
  `OPENCODE_CONFIG_DIR`.
- Auth: `OPENCODE_AUTH_CONTENT` (read by `Auth.all()`; semantics not fully
  verified — see §7), plus per-provider keys such as `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

## 6. Files OpenCode writes inside the cell

With credentials absent, a run created:

- `<config>/opencode/opencode.jsonc` and `<config>/opencode/.gitignore`
  (OpenCode auto-creates a minimal global config when none exists).
- `<cache>/opencode/models.json` (~4.6 MB, models.dev cache).
- `<data>/opencode/opencode.db` (+ `-wal`/`-shm`); tables include
  `message`, `part`, `session`, `credential`, `account`, `permission`, …
- `<data>/opencode/snapshot/<hash>/…` (a git repo used for file snapshots).
- `<state>/opencode/locks/…` and `<data>/opencode/log/…`.

No `auth.json` was created without credentials. The `credential` table in the
isolated DB coexists with the `auth.json` store observed in §7; the exact split
is not fully mapped (accepted risk).

## 7. Auth store

- Real store observed on the host: `~/.local/share/opencode/auth.json`,
  shape `{ "<provider>": { "type": "...", "key": "..." } }`. (`opencode auth list`
  reads it.) No OS keychain path was observed; store is file-based.
- `OPENCODE_AUTH_CONTENT` is consulted by `Auth.all()` before the file; its
  exact read/write semantics were not verified and it is **not adopted** by the
  design until confirmed.
- OAuth token refresh write-through to the isolated `auth.json` was not
  exercised (no OAuth login used in an isolated run).

## 8. Unverified / accepted risks

| Item                                                                                   | Status                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS managed config (`/Library/Application Support/opencode/`, `ai.opencode.managed`) | Not testable on this host (no MDM). Absolute path, not redirectable; record as accepted risk with rationale (admin-controlled, not profile-writable). |
| Remote `.well-known/opencode` config                                                   | Not exercised; org-auth dependent.                                                                                                                    |
| `--pure` behavioral delta                                                              | Plugin surface was empty by default in the cell; delta not demonstrated. `OPENCODE_PURE=1` / `--pure` exists per docs.                                |
| OAuth refresh write-through                                                            | Not exercised.                                                                                                                                        |
| `credential` DB table vs `auth.json` split                                             | Partially mapped.                                                                                                                                     |
| Authed run (`SPIKE_WITH_AUTH=1`)                                                       | Skipped: no credential was forwarded into the isolated env during the spike.                                                                          |

## 9. Consequences locked into the design doc

1. Adapter sets `XDG_*` **and `TMPDIR`**, plus `OPENCODE_DISABLE_AUTOUPDATE=1`,
   `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`.
2. `{file:...}` / `{env:...}` references in materialized profile config are
   guarded at the materialization boundary (outside-cell / credential-store
   targets rejected, fail closed).
3. Credential bridging: provider API-key env forwarding (supported) and an
   opt-in `auth.json` copy (experimental); `OPENCODE_AUTH_CONTENT` deferred.
4. Usage is summed from `step_finish`; `model.resolved` is `null` with an
   explicit reason; malformed lines and unobserved uses are persisted as
   diagnostics.
5. Minimum supported version: `>= 1.18.0` (verified on both 1.18.0 and 1.18.30).
