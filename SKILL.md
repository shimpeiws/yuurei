---
name: yuurei
description: Run a coding agent (Claude Code, Codex) in an isolated, reproducible environment and read the resulting trace. Use when you must execute an agent task without touching the operator's real global agent configuration, or when you need a machine-readable record of a run.
---

# yuurei

`yuurei` builds a temporary execution cell per run, runs a coding agent inside it
against an isolated configuration, and writes a runtime-agnostic `trace.json`.
Use it to run a task reproducibly without modifying the operator's everyday
global configuration.

## Install

`npx skills add` installs this skill, not the CLI. If `yuurei` is not already on
`PATH`, install it first:

```sh
npm install -g yuurei
```

## Shortest path

Run these from the directory that will hold the project:

```sh
yuurei doctor --json                      # 1. check the environment and auth
yuurei init                               # 2. scaffold .yuurei/ (once)
yuurei run hello --json                   # 3. execute the scaffolded task
cat .yuurei/runs/<run-id>/trace.json      # 4. read the full record
```

`init` writes `.yuurei/yuurei.yaml`, one profile, and one safe task. It never
overwrites existing files and creates no credentials. It scaffolds a run named
after the task, so `run hello` works out of the box; `run` prints the run ID and
the run directory.

## Reading the output

Every command accepts `--json`. With it, each status line is one JSON object on
its own line (NDJSON), shaped `{"level": "...", "message": "...", ...data}`.
`level` is one of `info`, `warn`, or `error`. Informational lines go to stdout;
error lines go to stderr.

```text
{"level":"info","message":"run <run-id> finished","exitCode":0,"signal":null,"runDir":"..."}
```

`yuurei trace show <run-id>` prints only a summary (runtime, exit code, signal,
duration, timeout). The full record is the file:

```sh
cat .yuurei/runs/<run-id>/trace.json
```

`trace.json` is written last, as the completion marker for a run. A failure
before execution completes can leave the run directory with no trace at all. If
the file is missing, read the CLI's stderr and the run directory's logs
instead.

It carries `schema_version`, `run_id`, `runtime`, `model`, the profile and task
digests, the `isolation` verification result, and:

```json
"execution": { "exit_code": 0, "signal": null, "duration_ms": 1234, "timed_out": false }
```

Check `execution.exit_code` and `execution.timed_out` to decide whether the task
succeeded. A printed `finished` message alone is not success. The same directory
also holds `stdout.log`, `stderr.log`, and `artifacts.json`.

## Exit codes

| Code | Meaning                          |
| ---: | -------------------------------- |
|    0 | Execution succeeded              |
|    2 | Configuration error              |
|    3 | Runtime not found or unsupported |
|    4 | Isolation verification failed    |
|    5 | Runtime execution failed         |
|    6 | Trace or artifact save failed    |

A run killed by a signal exits with the shell convention: 130 for `SIGINT`, 143
for `SIGTERM`.

## Trust boundary

- **Never put credentials in a profile or a task file.** The supported
  authentication path passes credentials by environment variable only:
  `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` for Claude Code,
  `OPENAI_API_KEY` for Codex. (Codex also has an experimental, opt-in
  `--bridge-codex-auth-file` path; a profile must not supply any credential
  file.) A token written into `profile.yaml` or a task is the
  highest-consequence mistake available with this tool.
- **Profiles and tasks are executed code, not data.** The runtime runs their
  hooks, settings, and commands. Keep them trusted the way you trust a script.
- **Isolation is configuration-level, not a sandbox.** Levels 0–1 separate the
  agent's configuration and environment from the operator's; they are not a
  security boundary against malicious code (design doc §9.3).

See the repository `README.md` and `docs/getting-started.md` for authentication
setup and the full command list.
