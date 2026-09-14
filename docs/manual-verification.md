# Manual verification guide

This guide documents hands-on checks that automated tests cannot cover, such
as running against a real installed runtime. Each section states what it
verifies and provides exact copy-paste commands with expected outcomes.

> **Runtime requirement:** sections marked _(requires runtime)_ need
> `claude`, `codex`, or `opencode` installed and authenticated. Sections that
> exercise rejection paths require no runtime.

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
- `artifacts.json`, `stdout.log`, and `stderr.log` exist.
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
