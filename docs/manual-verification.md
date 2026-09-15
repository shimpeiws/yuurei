# Manual verification guide

This guide documents hands-on checks that automated tests cannot cover, such
as running against a real installed runtime. Each section states what it
verifies and provides exact copy-paste commands with expected outcomes.

> **Runtime requirement:** sections marked _(requires runtime)_ need
> `claude`, `codex`, or `opencode` installed and authenticated. Sections that
> exercise rejection paths require no runtime.

---

## Automation status

Every section below is either covered by CI or deliberately manual, with the
reason. **Automated** means the repository's tests exercise it: the fake-runtime
suite on every pull request, and the real-runtime suite on the nightly and
release-candidate runs (ADR-0017), which install pinned runtime versions.

| Section                                 | Status    | Note                                                                                       |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| Authentication 1 — Claude subscription  | Manual    | Needs an interactive `claude setup-token`; no way to mint it unattended in CI.             |
| Authentication 2 — Claude API key       | Automated | Real-runtime run forwards `ANTHROPIC_API_KEY`.                                             |
| Authentication 3 — Codex API key        | Automated | Real-runtime run forwards `OPENAI_API_KEY`.                                                |
| Authentication 4 — Codex auth-file      | Manual    | Needs a real interactive ChatGPT login; the bridge is experimental and rotation-sensitive. |
| Codex E2E 1–3 (build, project, key)     | Automated | Real-runtime run.                                                                          |
| Codex E2E 4 (auth-file bridge)          | Manual    | Same reason as Authentication 4.                                                           |
| Codex E2E 5 (`--keep` scrubbing)        | Manual    | Requires a bridged credential to scrub; that needs an interactive login.                   |
| Codex E2E 6 (interruption)              | Automated | Integration signal tests cover interruption during `prepare()`.                            |
| OpenCode E2E 1–3 (build, project, key)  | Automated | Real-runtime run.                                                                          |
| OpenCode E2E 4 (file bridge)            | Manual    | Same reason as Authentication 4.                                                           |
| OpenCode E2E 5 (`--keep` scrubbing)     | Manual    | Same reason as Codex E2E 5.                                                                |
| OpenCode E2E 6 (config guard)           | Automated | Config-guard tests; rejection happens before the runtime starts, so no runtime is needed.  |
| Task path boundary 1–3                  | Automated | Task-path integration tests.                                                               |
| Task path boundary 4 (isolation caveat) | Manual    | A caveat to reason about, not a runnable check.                                            |

---

## Authentication paths

This section verifies each supported authentication path without printing
credential values. It confirms the behavior the tests cover in isolation: how
`yuurei doctor` judges credentials, how the Codex auth-file bridge behaves, and
what happens to the isolated copy afterward.

### 1. Claude Code — subscription token _(requires runtime)_

Run `claude setup-token` and export the printed token, then confirm the
variable is present without printing its value:

```sh
claude setup-token
export ANTHROPIC_AUTH_TOKEN='<token from claude setup-token>'
[ -n "$ANTHROPIC_AUTH_TOKEN" ] && echo present || echo absent
```

**Expected outcome:**

- `echo present` (the token is not printed).
- `claude-code` shows `status: installed`, `supported: yes`, and
  `authentication: ready`.

Note: `claude auth status` may report `loggedIn: true` while `yuurei doctor`
reports `authentication: required` for `claude-code`. These check different
stores — `claude auth status` reads the OS credential store, while yuurei
checks for an explicit environment variable. Both can be true at the same time;
the values are independent.

### 2. Claude Code — API key

```sh
export ANTHROPIC_API_KEY='<api-key>'
[ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent
```

**Expected outcome:**

- `echo present`.
- `yuurei doctor` reports `authentication: ready` for `claude-code`.
- Use one Claude path at a time in a fresh shell (mixing the subscription
  token and the API key is ambiguous and unsupported).

### 3. Codex — API key

```sh
export OPENAI_API_KEY='<api-key>'
[ -n "$OPENAI_API_KEY" ] && echo present || echo absent
```

**Expected outcome:**

- `echo present`.
- `yuurei doctor` reports `codex` with `authentication: ready` when
  `OPENAI_API_KEY` is set.
- With only an interactive login available (a `~/.codex/auth.json` and no
  `OPENAI_API_KEY`), `yuurei doctor` reports `authentication: required` for
  `codex`. That is the check's scope, not proof that the explicit bridge below
  cannot run.

### 4. Codex — existing interactive login via the auth-file bridge _(requires runtime)_

```sh
test -f ~/.codex/auth.json && echo 'auth file present' || echo absent
```

**Expected outcome:** `auth file present` only if an interactive login exists.
If absent, the bridge no-ops: the run proceeds unauthenticated rather than
failing.

To run with the real interactive login reused in the isolated run:

```sh
yuurei run <run-name> --bridge-codex-auth-file
```

**Expected outcome:**

- The run proceeds with a copy of `~/.codex/auth.json` in the isolated
  `CODEX_HOME` at mode `0600`.
- The real `~/.codex/auth.json` is unmodified before and after the run.
- After the run (and on `SIGINT`/`SIGTERM`), the isolated credential copy is
  scrubbed even when `--keep` is set — `--keep` preserves config and logs for
  debugging, never credentials.
- `--bridge-codex-auth-file` is experimental and off by default; it is an
  explicit opt-in flag and only applies to the Codex runtime.

**Known limitation:** the file can carry a rotating OAuth access/refresh token
pair. If the token refreshes mid-run, only the isolated copy receives the new
state; the real file stays stale, and the valid rotated copy is discarded on
cleanup. Writing the rotated state back would violate the "never modify the
user's existing global configuration" guarantee, so this is documented rather
than "fixed". Credentials are never recorded into profiles, tasks, traces,
artifacts, or logs.

## Codex end-to-end run

This section verifies a real Codex run from an isolated project. It checks the
runtime launch, the saved trace, the durable logs, and cleanup of the isolated
credential copy.

### 1. Build the CLI

Run these commands from the repository root:

```sh
pnpm install
pnpm run build
export YUUREI_CLI="$PWD/dist/index.js"
yuurei() { node "$YUUREI_CLI" "$@"; }
```

Check that the runtime is available:

```sh
codex --version
yuurei doctor
```

Expected results:

- `codex --version` prints a supported Codex CLI version.
- `yuurei doctor` reports Codex as installed and supported.
- With `OPENAI_API_KEY` set, `yuurei doctor` reports `authentication: ready`.
- With only `~/.codex/auth.json` available, `yuurei doctor` may report `authentication: required`. The doctor check covers the API-key path only.

### 2. Create a Codex project

Create the test project outside the repository so the run cannot change the
repository files:

```sh
TEST_ROOT="$(mktemp -d /tmp/yuurei-codex-check.XXXXXX)"
yuurei init "$TEST_ROOT" --runtime codex --profile codex-basic --task hello --run codex-check
cd "$TEST_ROOT"
```

Inspect the resolved profile before running Codex:

```sh
yuurei profile list
yuurei inspect codex-basic
```

Expected results:

- The project contains `.yuurei/yuurei.yaml`, a Codex profile, and `tasks/hello.md`.
- `yuurei profile list` lists `codex-basic` with runtime `codex`.
- `yuurei inspect codex-basic` succeeds without starting Codex.

### 3. Run Codex with an API key

Use this path when `OPENAI_API_KEY` is available:

```sh
test -n "${OPENAI_API_KEY:-}" || echo "OPENAI_API_KEY is not set; skip the API-key run"
if [ -n "${OPENAI_API_KEY:-}" ]; then
  yuurei run codex-check
fi
```

Expected results for the API-key run:

- The command exits successfully.
- The output reports `run <run-id> finished` with `exitCode: 0` and `signal: null`.
- `.yuurei/runs/<run-id>/trace.json` exists and records runtime `codex`.
- `.yuurei/runs/<run-id>/artifacts.json`, `stdout.log`, `stderr.log`,
  `patch.diff` and `workspace/` exist.
- The run does not create or modify `~/.codex/auth.json`.

Save the run ID from the command output, then inspect the trace:

```sh
yuurei trace show <run-id>
```

The command prints the Codex runtime, exit code, signal, duration, and timeout
status without printing task output or credentials. Add `--json` to print the
whole trace, so no field requires opening `trace.json`.

### 4. Run Codex with the interactive login bridge

Use this path when `~/.codex/auth.json` exists and `OPENAI_API_KEY` is not set:

```sh
test -f "$HOME/.codex/auth.json" || echo "~/.codex/auth.json is not present; skip the bridge run"
if [ -f "$HOME/.codex/auth.json" ]; then
  SOURCE_AUTH="$HOME/.codex/auth.json"
  SOURCE_SHA256="$(shasum -a 256 "$SOURCE_AUTH" | awk '{print $1}')"
  yuurei run codex-check --bridge-codex-auth-file
  RESULT=$?
  AFTER_SHA256="$(shasum -a 256 "$SOURCE_AUTH" | awk '{print $1}')"
  test "$SOURCE_SHA256" = "$AFTER_SHA256"
  echo "source auth.json unchanged"
  test "$RESULT" -eq 0
fi
```

Expected results:

- The run uses a copy of `~/.codex/auth.json` under the isolated `CODEX_HOME`.
- The source file's checksum is unchanged.
- The command exits successfully when the interactive login is valid.
- The isolated `auth.json` is removed after the run.
- The trace and logs contain no access token, refresh token, API key, or auth header.

The bridge is experimental. It may refresh the token in the isolated copy,
but it never writes that refreshed token back to the source file.

### 5. Verify `--keep` cleanup

Run the bridge with `--keep` and inspect the run directory after completion:

```sh
if [ -f "$HOME/.codex/auth.json" ]; then
  yuurei run codex-check --bridge-codex-auth-file --keep
fi
```

Expected results:

- The isolated configuration and logs remain for debugging.
- The isolated `auth.json` does not remain under the kept isolation directory.
- The source `~/.codex/auth.json` remains unchanged.

Do not delete directories that belong to another active run. Check the
credential path without printing its contents:

```sh
find /tmp -path '*/.codex/auth.json' -print
```

The command must not list an `auth.json` created by this run.

### 6. Verify interruption during `prepare()`

This check exercises the Issue #55 failure window. Use a test environment with
a valid `~/.codex/auth.json`, then interrupt startup while the run is preparing:

```sh
yuurei run codex-check --bridge-codex-auth-file --keep
```

Press `Ctrl-C` while Codex startup is still in progress. Repeat the command if
the runtime starts before the signal reaches `prepare()`.

Expected results:

- The process exits with code `130`.
- The isolated credential copy is removed even though `--keep` is set.
- No partial run directory remains for the interrupted run.
- The source `~/.codex/auth.json` is unchanged.

Use the automated regression test when a deterministic interruption is needed:

```sh
pnpm test -- test/integration/signal-cleanup.test.ts
```

The test covers a credential written during `prepare()` and a signal delivered
before `prepare()` returns.

---

## OpenCode end-to-end run

This section verifies a real OpenCode run from an isolated project. It checks
the runtime launch, the saved trace, the durable logs, and cleanup of the
isolated credential copy.

### 1. Build the CLI

Run these commands from the repository root:

```sh
pnpm install
pnpm run build
export YUUREI_CLI="$PWD/dist/index.js"
yuurei() { node "$YUUREI_CLI" "$@"; }
```

Check that the runtime is available:

```sh
opencode --version
yuurei doctor
```

Expected results:

- `opencode --version` prints `1.18.0` or later.
- `yuurei doctor` reports `opencode` as installed and supported.
- With an allowlisted provider key set (for example `OPENROUTER_API_KEY`),
  `yuurei doctor` reports `authentication: ready`.
- With no credential, `yuurei doctor` reports `authentication: required` for
  `opencode`; that is not a hard failure, because OpenCode can run through its
  free default provider.

### 2. Create an OpenCode project

Create the test project outside the repository:

```sh
TEST_ROOT="$(mktemp -d /tmp/yuurei-opencode-check.XXXXXX)"
yuurei init "$TEST_ROOT" --runtime opencode --profile opencode-basic --task hello --run opencode-check
cd "$TEST_ROOT"
```

Inspect the resolved profile before running:

```sh
yuurei profile list
yuurei inspect opencode-basic
```

Expected results:

- The project contains `.yuurei/yuurei.yaml`, an OpenCode profile, and `tasks/hello.md`.
- `yuurei profile list` lists `opencode-basic` with runtime `opencode`.
- `yuurei inspect opencode-basic` succeeds without starting OpenCode.

### 3. Run OpenCode with a provider API key

Use this path when a provider key is available:

```sh
test -n "${OPENROUTER_API_KEY:-}" || echo "OPENROUTER_API_KEY is not set; the free-provider path may still run"
yuurei run opencode-check
```

Expected results:

- The command exits successfully (or, without a credential, still succeeds via
  the free default provider).
- The output reports `run <run-id> finished` with `exitCode: 0` and `signal: null`.
- `.yuurei/runs/<run-id>/trace.json` records runtime `opencode`, with
  `model.resolved: null` and `model.resolved_reason: "unobserved"`.
- `usage` carries the `step_finish` token counts and `cost_usd` when reported.
- `artifacts.json`, `stdout.log`, `stderr.log`, `patch.diff` and `workspace/`
  exist.
- The run does not create or modify `~/.local/share/opencode/auth.json`.

Save the run ID from the output, then inspect the trace:

```sh
yuurei trace show <run-id>
```

### 4. Run OpenCode with the file-based login bridge

Use this path when `~/.local/share/opencode/auth.json` exists:

```sh
test -f "$HOME/.local/share/opencode/auth.json" || echo "OpenCode auth.json is not present; skip the bridge run"
if [ -f "$HOME/.local/share/opencode/auth.json" ]; then
  SOURCE_AUTH="$HOME/.local/share/opencode/auth.json"
  SOURCE_SHA256="$(shasum -a 256 "$SOURCE_AUTH" | awk '{print $1}')"
  yuurei run opencode-check --bridge-opencode-auth-file
  RESULT=$?
  AFTER_SHA256="$(shasum -a 256 "$SOURCE_AUTH" | awk '{print $1}')"
  test "$SOURCE_SHA256" = "$AFTER_SHA256"
  echo "source auth.json unchanged"
  test "$RESULT" -eq 0
fi
```

Expected results:

- The run uses a copy of the real `auth.json` under the isolated data directory
  at mode `0600`.
- The source file's checksum is unchanged.
- The isolated copy is removed after the run.
- The trace and logs contain no API key, access token, or refresh token.

### 5. Verify `--keep` cleanup

```sh
if [ -f "$HOME/.local/share/opencode/auth.json" ]; then
  yuurei run opencode-check --bridge-opencode-auth-file --keep
fi
```

Expected results:

- The isolated configuration and logs remain for debugging.
- The isolated `auth.json` does not remain under the kept isolation directory.
- The source auth file remains unchanged.

### 6. Verify the config guard (no runtime needed)

A profile whose `opencode.json` reaches outside the cell, or hardcodes a
provider key, is rejected before OpenCode starts. From the test project:

```sh
PROFILE_CFG=".yuurei/profiles/opencode-basic/config/opencode.json"
printf '%s\n' '{"provider":{"p":{"options":{"apiKey":"{file:/etc/hosts}"}}}}' > "$PROFILE_CFG"
yuurei run opencode-check; echo "exit=$?"
printf '%s\n' '{"provider":{"p":{"options":{"apiKey":"sk-literal-secret"}}}}' > "$PROFILE_CFG"
yuurei run opencode-check; echo "exit=$?"
```

Expected results:

- Both runs exit with code `2` (CONFIG_ERROR).
- The error names the profile config and the offending reference.
- No run directory is created for either attempt.
- No OpenCode process is started.

---

## Task path trust boundary

Yuurei enforces different rules for two kinds of task paths:

| Source                                   | Rule                       | Rationale                                                  |
| ---------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `--task <path>` (direct CLI)             | May point anywhere         | Explicit choice by the trusted operator                    |
| Named-run `task:` field in `yuurei.yaml` | Must stay inside `.yuurei` | Loaded indirectly from project configuration — fail closed |

Level 0 and Level 1 isolation are configuration/environment-level isolation,
not complete filesystem isolation (see design doc §9.3). The containment
boundary for task paths is a separate, complementary check.

### 1. Direct external task — accepted (positive case)

A task file supplied directly on the command line may be outside `.yuurei`.
This is deliberate: the operator made an explicit choice.

Create a task file anywhere on the filesystem:

```sh
echo '# My task' > /tmp/outside-task.md
```

Run yuurei pointing at it:

```sh
cd <your-project>
yuurei run --profile <profile-name> --task /tmp/outside-task.md
```

**Expected outcome:** yuurei accepts the path and starts the runtime.
`trace.json` records `isolation.verified: true`. There is no error about
the task path escaping `.yuurei`.

> Note: a real runtime must be installed and the profile must exist for the
> run to complete successfully.

### 2. Named-run task escape — rejected before the runtime starts (negative case)

A named run whose `task:` field in `yuurei.yaml` resolves to a path outside
`.yuurei` is rejected before any profile loading or runtime execution.

Add an escaping run entry to `.yuurei/yuurei.yaml`:

```yaml
runs:
  escape-test:
    profile: claude-basic # must be a valid profile name
    task: ../escape.md # resolves to one level above .yuurei
```

Then run it:

```sh
yuurei run escape-test
```

**Expected outcome:**

- Nonzero exit code (exit 2 — CONFIG\_ERROR).
- Error message names the escaping path, e.g.:
  ```
  Error: task path escapes the .yuurei directory: ../escape.md
  ```
- No run directory is created under `.yuurei/runs/` (the runtime was never
  started, so no partial trace exists).

Verify no partial artifacts were written:

```sh
ls .yuurei/runs/ 2>/dev/null || echo "(no runs directory)"
```

Remove the test entry from `yuurei.yaml` when done.

### 3. Trust distinction

The two cases above illustrate a deliberate asymmetry:

- **Operator-supplied CLI path** (`--task /tmp/outside-task.md`): treated as
  an explicit, trusted choice. The operator controls the command line and is
  responsible for what they pass in.

- **Indirect path from project configuration** (`runs.*.task` in
  `yuurei.yaml`): treated as untrusted content loaded from a file that may
  have been written by someone else or checked in from a remote source. yuurei
  resolves it relative to `.yuurei` and rejects it if the result escapes that
  directory. Failure is closed — the runtime is not started.

### 4. Isolation caveat

Level 0 isolation redirects only the runtime's config-root arguments and
environment variables. Level 1 additionally uses a temporary `HOME`. Neither
level provides complete filesystem isolation — a coding agent under execution
can still read and write arbitrary paths on the host filesystem (design doc
§9.3). The task-path containment check is not a security boundary against
malicious code; it prevents misconfigured project files from accidentally
pointing outside `.yuurei`.
