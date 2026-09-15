# Getting started

Create a minimal Claude Code profile, run a task, and read the saved trace
and logs. Run the commands below in a POSIX shell. The steps apply to Codex
and OpenCode too — swap the runtime name and the credential described below.

## Prepare the CLI

Use Node.js 21 or later. Install yuurei from npm:

```sh
npm install -g yuurei
```

Or build it from a source checkout:

```sh
pnpm install
pnpm run build
export YUUREI_CLI="$PWD/dist/index.js"
yuurei() { node "$YUUREI_CLI" "$@"; }
yuurei --help
```

Keep this shell open for the remaining steps. Install Claude Code
separately so that `claude` is on `PATH`. Yuurei's adapter checks for
Claude Code 2.0.0 or later.

## Set up authentication (required)

`yuurei` forwards explicit credential variables into the isolated runtime.
It does **not** copy your usual Claude Code configuration or read your
interactive login from the OS credential store (design doc §9.2/§10.2).
Keep credentials out of profile and task files.

### Claude Code

**Subscription login (default path):** run `claude setup-token` once in
this shell to obtain a long-lived token, then export it:

```sh
claude setup-token
# follow the prompts, then copy the token it prints
export ANTHROPIC_AUTH_TOKEN='<token from claude setup-token>'
```

**API key:** export `ANTHROPIC_API_KEY` instead:

```sh
export ANTHROPIC_API_KEY='<api-key>'
```

Note: `claude auth status` may report `loggedIn: true` while `yuurei doctor`
reports `authentication: required`. These check different stores — `claude auth
status` reads the OS credential store; yuurei checks for an explicit
environment variable. A shell export applies only to that shell and its
child processes; do not persist the token in a profile, task, or committed
file.

### Codex

**API key (default path):** export `OPENAI_API_KEY`:

```sh
export OPENAI_API_KEY='<api-key>'
```

**Existing interactive login (experimental, opt-in):** if you already have a
`~/.codex/auth.json` from a `codex` interactive login, you can reuse it in
the isolated run with `--bridge-codex-auth-file`:

```sh
yuurei run <run-name> --bridge-codex-auth-file
```

This flag is experimental and off by default. When enabled, yuurei copies
exactly `~/.codex/auth.json` into the isolated run, runs with it, and scrubs
the isolated copy afterward. The real global file is never modified. It is an
explicit opt-in because that file can carry a rotating OAuth access/refresh
token pair: if the token refreshes mid-run, only the isolated copy receives
the new state while the real file stays stale, and the valid rotated copy is
then discarded on cleanup. The guarantees — the real `~/.codex/auth.json` is
never modified, and the isolated copy is scrubbed on normal exit and on
catchable signals (`SIGINT`, `SIGTERM`) even under `--keep` — are the
[contract's](contract.md); the flag's name and shape may change or be removed
in a minor release. Do not copy credentials into profile or task files.

### OpenCode

**Provider API key (default path):** export a provider API key that OpenCode
recognizes, for example `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY`:

```sh
export OPENROUTER_API_KEY='<api-key>'
```

Yuurei's adapter checks for OpenCode 1.18.0 or later. OpenCode can also run
unauthenticated through its free default provider, so `yuurei doctor`
reporting `authentication: required` for `opencode` means no allowlisted
provider key was found — it is not a hard failure for a free-provider run.

**Existing file-based login (experimental, opt-in):** if you signed in with
`opencode auth login`, reuse the file-based credential store with
`--bridge-opencode-auth-file`:

```sh
yuurei run <run-name> --bridge-opencode-auth-file
```

This is experimental and off by default, and behaves like the Codex bridge:
yuurei copies exactly `~/.local/share/opencode/auth.json` into the isolated
cell, runs with it, and scrubs the isolated copy afterward — even under
`--keep`. The real file is never modified, and the same mid-run OAuth refresh
limitation applies. The guarantees are the [contract's](contract.md), and the
flag's name and shape may change or be removed in a minor release.

### Verify the environment

Now verify the environment works:

```sh
yuurei doctor
```

Each runtime prints as a compact status block:

```text
claude-code
  status: installed
  version: <installed-version>
  supported: yes
  authentication: ready
```

Look for `status: installed`, `supported: yes`, and `authentication: ready`
for the runtime you plan to use. The check detects an explicit environment
credential; it does not validate the credential with the service. If a runtime
shows `authentication: required`, `yuurei doctor` prints safe,
runtime-specific next steps. For Codex, the check reflects an `OPENAI_API_KEY`
export only: an available `~/.codex/auth.json` for explicit bridging does not
make it report `authentication: ready`. Codex can be absent for this tutorial.
Use `yuurei doctor --json` for machine-readable output.

Verify a credential variable is present without printing its value:

```sh
[ -n "$ANTHROPIC_AUTH_TOKEN" ] && echo present || echo absent
[ -n "$OPENAI_API_KEY" ] && echo present || echo absent
[ -n "$OPENROUTER_API_KEY" ] && echo present || echo absent
```

## Scaffold the project

Start with an empty directory and run `yuurei init`:

```sh
mkdir yuurei-demo
cd yuurei-demo
yuurei init
```

The command creates a valid first project:

```text
.yuurei/
├── yuurei.yaml
├── profiles/
│   └── claude-basic/
│       ├── profile.yaml
│       └── config/
│           └── .gitkeep
└── tasks/
    └── hello.md
```

The generated task asks for a reply only and does not modify files or run
commands. Yuurei sends the task file's text to the runtime as the prompt.
The runtime starts in a temporary directory with an isolated home. Yuurei
does not copy this project's source files into that directory, so this
first task needs no project files.

Isolation here is **configuration and environment separation**, not a
container or an OS sandbox: it keeps the run away from your global runtime
config, but the code the agent runs can reach anything your user account can.
The [public contract](contract.md) states exactly what is guaranteed.

`init` never overwrites existing files: re-run it on an untouched scaffold
and it reports that the project is already initialized; if a generated file
differs, it stops and lists the exact conflicts before writing anything. It
creates no credentials, `.env` files, or global runtime configuration.

`init` accepts options to choose the runtime, profile, task, run, and
target directory:

```sh
yuurei init --runtime codex --profile codex-basic --task hello --run first-run
yuurei init ../other-project
```

The default runtime is `claude-code`, the default profile name is
`claude-basic`, and the default task and run name is `hello`. The scaffolded
`yuurei.yaml` registers one profile and one named run. Pass
`--runtime opencode --profile opencode-basic` (or `--runtime codex
--profile codex-basic`) to scaffold for another runtime. You can also create
and edit these files by hand for full customization; the format is described
below.

## The project layout

Yuurei searches upward from the current directory for `.yuurei/`, like git
finds `.git/`. The configuration lives at `.yuurei/yuurei.yaml`:

```yaml
version: 1

profiles:
  claude-basic:
    runtime: claude-code
    source: ./profiles/claude-basic

runs:
  hello:
    profile: claude-basic
    task: ./tasks/hello.md
```

`source` and the named run's `task` are relative to `.yuurei/`. The named
task must stay inside that directory.

## Write the profile

Each profile has a `profile.yaml` like this one:

```yaml
runtime: claude-code
description: Minimal Claude Code profile for a first run.
```

`runtime` is required and `description` is optional. Keep the runtime
in this file and in `yuurei.yaml` the same.

Leave `config/` empty (`init` puts a `.gitkeep` in it) for this first run.
When you add files, yuurei reads their contents and copies them into the
runtime's isolated configuration directory, preserving relative paths:

- For Claude Code, `config/settings.json` becomes
  `$CLAUDE_CONFIG_DIR/settings.json`, and `config/skills/example/SKILL.md`
  becomes `$CLAUDE_CONFIG_DIR/skills/example/SKILL.md`.
- For Codex, `config/config.toml` becomes `$CODEX_HOME/config.toml`.
- For OpenCode, `config/opencode.json` becomes
  `$XDG_CONFIG_HOME/opencode/opencode.json`, and `config/commands/deploy.md`
  becomes `$XDG_CONFIG_HOME/opencode/commands/deploy.md`.

These are runtime-native files. Yuurei copies them but does not interpret
their settings or translate them between runtimes. The receiving CLI
determines which files and settings it supports. Profile file contents
contribute to the profile digest saved with the run. Your normal global
configuration is not imported automatically.

For a Codex profile, use `runtime: codex` in both YAML files and export
`OPENAI_API_KEY` (or reuse an interactive login with the experimental
`--bridge-codex-auth-file` flag — see the authentication section above).
Codex profile `config/auth.json` is reserved and rejected; do not put
credentials there.

For an OpenCode profile, use `runtime: opencode` in both YAML files and export
an allowlisted provider key (or reuse a file-based login with the experimental
`--bridge-opencode-auth-file` flag). A profile's `opencode.json` may not
hardcode a provider `apiKey` and may not use a `{file:...}` reference that
resolves outside the isolated cell; use `{env:...}` to reference a forwarded
credential.

## Inspect and run

Check that yuurei can find and resolve the profile:

```sh
yuurei profile list
yuurei inspect claude-basic
```

The list includes `claude-basic`. Inspect reports its runtime and digest
without starting an agent.

Run the named task:

```sh
yuurei run hello
```

Or select the profile and task directly from the project root:

```sh
yuurei run --profile claude-basic --task .yuurei/tasks/hello.md
```

The direct `--task` path is relative to your current working directory
and may point outside `.yuurei` — this is an explicit operator choice and
is allowed by design. A named run's `task:` field in `yuurei.yaml`, by
contrast, is resolved relative to `.yuurei` and must stay inside it; yuurei
rejects a path that escapes before starting the runtime.
Each invocation creates a separate run. To request a model, add
`--model <model-name>`. To limit execution time, add `--timeout 60000`
for a 60-second timeout. There is no timeout by default. To select the
isolation strategy, add `--isolation level0` or `--isolation level1`
(default: `level1`, a temporary `HOME`; `level0` only swaps the
runtime's config-root arguments/env vars — see the design document's
§9.3 for the difference).

A named run can carry `model`, `timeout` and `isolation` in `yuurei.yaml`
instead of passing them every time. A flag given on the command line
overrides the definition for that field only, so `--model` does not discard a
`timeout` the definition set.

After execution, yuurei prints `run <run-id> finished` with `exitCode`
and `runDir`. The agent's response is in the saved logs.

## Read the trace and logs

Replace the value below with the run ID printed by your command:

```sh
RUN_ID='replace-with-your-run-id'
yuurei trace show "$RUN_ID"
cat ".yuurei/runs/$RUN_ID/trace.json"
cat ".yuurei/runs/$RUN_ID/stdout.log"
cat ".yuurei/runs/$RUN_ID/stderr.log"
```

`trace show` prints a summary containing the runtime, exit code, duration,
and timeout status. `trace.json` contains the full record, including the
profile and task digests and the isolation verification result.
`stdout.log` contains the runtime output; Claude Code's output is JSON.
Look there for the greeting. `stderr.log` contains runtime diagnostics.

Check `execution.exit_code` and `execution.timed_out` in the trace to
confirm the runtime succeeded. A `finished` message alone does not mean
the task succeeded. If authentication fails, check the credential
variables and `stderr.log`. A failure before execution completes can
leave no trace, so also read the CLI error output.

The run directory also contains `resolved-profile.json`, which records
the resolved profile contents, and `artifacts.json`, which lists the
saved logs and their digests. `workspace/` holds the files the agent
produced, and `patch.diff` is an all-additions unified diff of them
against an empty base: yuurei runs the agent in a fresh workspace, so the
patch shows what the agent created, not changes to your project tree.

Trace and log files remain after normal cleanup. To retain the temporary
execution directory for debugging, run `yuurei run hello --keep`; that
directory is separate from `.yuurei/runs/<run-id>/workspace/`, which is
kept regardless.

## Explore more profiles

See [examples/basic](../examples/basic/.yuurei/yuurei.yaml) for a
configuration with multiple profiles and named runs. The profile names
in that example do not install skill sets; only the files provided under
each profile's `config/` are copied.

See the [design document](design/yuurei-design-v0.3.md) for the broader
runtime and isolation model.
