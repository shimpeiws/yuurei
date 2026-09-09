# Getting started

Create a minimal Claude Code profile, run a task, and read the saved trace
and logs. Run the commands below in a POSIX shell.

## Prepare the CLI

Use Node.js 21 or later and pnpm. To build yuurei from a source checkout,
run these commands in the yuurei repository:

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

Export a valid `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in this shell
before running a task. Yuurei forwards these variables into the isolated
runtime. It does not copy your usual Claude configuration or read your
interactive login from the OS keychain. Keep credentials out of the
profile and task files.

```sh
yuurei doctor
```

Look for `claude-code: installed`, `versionSupported: true`, and
`authUsable: true` in the output. The authentication check detects an
available credential variable; it does not validate the credential with
the service. Codex can be absent for this tutorial.

## Create the project layout

Start with an empty directory:

```sh
mkdir yuurei-demo
cd yuurei-demo
mkdir -p .yuurei/profiles/claude-basic/config .yuurei/tasks
```

Create `.yuurei/yuurei.yaml`:

```sh
cat > .yuurei/yuurei.yaml <<'YAML'
version: 1

profiles:
  claude-basic:
    runtime: claude-code
    source: ./profiles/claude-basic

runs:
  hello:
    profile: claude-basic
    task: ./tasks/hello.md
YAML
```

`source` and the named run's `task` are relative to `.yuurei/`.
The named task must stay inside that directory. Yuurei searches upward
from the current directory for `.yuurei/`.

## Write the profile

Create `.yuurei/profiles/claude-basic/profile.yaml`:

```sh
cat > .yuurei/profiles/claude-basic/profile.yaml <<'YAML'
runtime: claude-code
description: Minimal Claude Code profile for a first run.
YAML
```

`runtime` is required and `description` is optional. Keep the runtime
in this file and in `yuurei.yaml` the same.

Leave `config/` empty for this first run. It can also be omitted.
When you add files, yuurei reads their contents and copies them into the
runtime's isolated configuration directory, preserving relative paths:

- For Claude Code, `config/settings.json` becomes
  `$CLAUDE_CONFIG_DIR/settings.json`, and `config/skills/example/SKILL.md`
  becomes `$CLAUDE_CONFIG_DIR/skills/example/SKILL.md`.
- For Codex, `config/config.toml` becomes `$CODEX_HOME/config.toml`.

These are runtime-native files. Yuurei copies them but does not interpret
their settings or translate them between runtimes. The receiving CLI
determines which files and settings it supports. Profile file contents
contribute to the profile digest saved with the run. Your normal global
configuration is not imported automatically.

For a Codex profile, use `runtime: codex` in both YAML files and export
`OPENAI_API_KEY`. Codex profile `config/auth.json` is reserved and rejected;
do not put credentials there.

## Write a task

Create `.yuurei/tasks/hello.md`:

```sh
cat > .yuurei/tasks/hello.md <<'MARKDOWN'
Reply with "Hello from yuurei." Do not read or write any files or run commands.
MARKDOWN
```

Yuurei sends the task file's text to the runtime as the prompt. The runtime
starts in a temporary directory with an isolated home. Yuurei does not
copy this project's source files into that directory, so this first task
needs no project files.

The project now contains:

```text
.yuurei/
├── yuurei.yaml
├── profiles/
│   └── claude-basic/
│       ├── profile.yaml
│       └── config/
└── tasks/
    └── hello.md
```

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

The direct `--task` path is relative to your current working directory.
Each invocation creates a separate run. To request a model, add
`--model <model-name>`. To limit execution time, add `--timeout 60000`
for a 60-second timeout. There is no timeout by default. To select the
isolation strategy, add `--isolation level0` or `--isolation level1`
(default: `level1`, a temporary `HOME`; `level0` only swaps the
runtime's config-root arguments/env vars — see the design document's
§9.3 for the difference).

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
saved logs and their digests. The current pipeline does not collect
project changes into a patch.

Trace and log files remain after normal cleanup. To retain the temporary
execution directory for debugging, run `yuurei run hello --keep`.
This directory is separate from `.yuurei/runs/<run-id>/workspace/`.

## Explore more profiles

See [examples/basic](../examples/basic/.yuurei/yuurei.yaml) for a
configuration with multiple profiles and named runs. The profile names
in that example do not install skill sets; only the files provided under
each profile's `config/` are copied.

See the [design document](design/yuurei-design-v0.3.md) for the broader
runtime and isolation model.
