# yuurei

> Isolated, reproducible runtime environments for coding agents

![Yuurei ghost DJ operating a mixing console](docs/assets/yuurei-top.jpg)

`yuurei` isolates coding-agent runtime environments (Claude Code, Codex,
OpenCode) from your normal global configuration, so different harness profiles
(skills, instructions, settings, hooks) can be swapped and run
reproducibly without touching or breaking your everyday setup.

## Why

Comparing harness or profile variants safely usually means backing up,
swapping, restarting, and restoring your global config by hand — a
process that gets fragile fast as the number of variants grows. `yuurei`
builds a temporary, isolated execution cell per run instead, and emits a
runtime-agnostic trace record (`trace.json`) that other tools — such as a
future ROI tracker — can consume. `yuurei` itself stays agnostic of any
such consumer; the dependency only ever points one way, from that tool
toward `yuurei`.

## What isolation means here

`yuurei` separates **configuration and environment variables**: it points a
runtime at an isolated config root and, at the default isolation level, a
temporary `HOME`, so the runtime does not read or write your everyday
`~/.claude` or `~/.codex`. It is **not** a container or an OS sandbox, and it
does **not** confine the code the agent runs — that code can reach anything your
user account can. Two runs are reproducible in the configuration they are given,
not in what the agent does. The guarantees the project makes, and the risks it
does not defend against, are stated in the
[public contract](docs/contract.md); this README points at it rather than
restating them.

## Quickstart

Install yuurei from npm, or build it from a source checkout:

```sh
npm install -g yuurei
```

Coding agents can install yuurei as a skill so they can discover and use the
CLI on their own:

```sh
npx skills add shimpeiws/yuurei
```

Check that the CLI is on your PATH:

```sh
yuurei --help
```

### Required authentication setup

`yuurei` forwards explicit credential variables into the isolated runtime. It
does **not** read your interactive login from the OS credential store, so you
must make a credential available explicitly before running a task. Keep
credentials out of profile and task files.

#### Claude Code

**Subscription login (default path):** Run `claude setup-token` once in this
shell to obtain a long-lived token, then export it before running any task:

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
status` reads the OS credential store; yuurei checks for an explicit environment
variable. A shell export applies only to that shell and its child processes; do
not persist the token in a profile, task, or committed file.

#### Codex

**API key (default path):** export `OPENAI_API_KEY`:

```sh
export OPENAI_API_KEY='<api-key>'
```

**Existing interactive login (experimental, opt-in):** if you already have a
`~/.codex/auth.json` from a `codex` interactive login, you can reuse it in the
isolated run with `--bridge-codex-auth-file`:

```sh
yuurei run <run-name> --bridge-codex-auth-file
```

This flag is experimental and off by default. When enabled, yuurei copies
exactly `~/.codex/auth.json` into the isolated run, runs with it, and scrubs
the isolated copy afterward. The real global file is never modified. It is an
explicit opt-in because that file can carry a rotating OAuth access/refresh
token pair: if the token refreshes mid-run, only the isolated copy receives the
new state while the real file stays stale, and the valid rotated copy is then
discarded on cleanup. The guarantees — the real `~/.codex/auth.json` is never
modified, and the isolated copy is scrubbed on normal exit and on catchable
signals (`SIGINT`, `SIGTERM`) even under `--keep` — are the
[contract's](docs/contract.md); the flag's name and shape may change or be
removed in a minor release. Do not copy credentials into profiles, tasks,
traces, artifacts, or logs.

#### OpenCode

**Provider API key (default path):** export a provider API key that OpenCode
recognizes, for example `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY`:

```sh
export OPENROUTER_API_KEY='<api-key>'
```

OpenCode's adapter requires OpenCode 1.18.0 or later. OpenCode can also run
unauthenticated through its free default provider, so `yuurei doctor` reporting
`authentication: required` means no allowlisted provider key was found — it is
not a hard failure for a free-provider run.

**Existing file-based login (experimental, opt-in):** if you signed in with
`opencode auth login`, you can reuse the file-based credential store with
`--bridge-opencode-auth-file`:

```sh
yuurei run <run-name> --bridge-opencode-auth-file
```

Like the Codex bridge, this is experimental and off by default: yuurei copies
exactly `~/.local/share/opencode/auth.json` into the isolated cell, runs with
it, and scrubs the isolated copy afterward — even under `--keep`. The real file
is never modified. The flag is an explicit opt-in because that file can carry a
rotating OAuth token pair, with the same mid-run refresh limitation as Codex.
The guarantees are the [contract's](docs/contract.md), and the flag's name and
shape may change or be removed in a minor release.

OpenCode materializes profile config under the isolated config directory and
disables project-config, external-skill, and auto-update loading. A profile's
`opencode.json` may not hardcode a provider `apiKey` or use a `{file:...}`
reference that escapes the cell.

#### Verify the environment

Check that the environment is ready:

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

codex
  status: installed
  version: <installed-version>
  supported: yes
  authentication: required
    Export OPENAI_API_KEY in this shell and re-run `yuurei doctor`. ...
```

Look for `authentication: ready` for the runtime you plan to use. If a runtime
reports `authentication: required`, `yuurei doctor` prints safe,
runtime-specific next steps. Note that the check reflects an explicit
environment credential, not whether an interactive login exists: Codex can
report `authentication: required` even when a `~/.codex/auth.json` is available
for explicit bridging, because the check detects `CODEX_API_KEY` or
`OPENAI_API_KEY`. Verify a
credential variable is present without printing its value:

```sh
[ -n "$ANTHROPIC_AUTH_TOKEN" ] && echo present || echo absent
[ -n "$OPENAI_API_KEY" ] && echo present || echo absent
[ -n "$OPENROUTER_API_KEY" ] && echo present || echo absent
```

Orphaned temp directories are listed with a prominent count and the
`yuurei clean` recovery command. Pass `--json` for machine-readable output that
scripts can consume, one JSON object per line:

```text
{"level":"info","message":"claude-code: installed","version":"<installed-version>","versionSupported":true,"authUsable":true}
```

### Create a first project

A Yuurei project keeps its configuration under `.yuurei/`. The project
configuration names profiles and runs. A profile selects a runtime and its
runtime-native config files. A task is the instruction sent to that runtime.
Each run creates a trace and logs under `.yuurei/runs/<run-id>/`.

Create the smallest Claude Code project with the scaffold command:

```sh
mkdir yuurei-demo
cd yuurei-demo
yuurei init
```

`init` writes a valid `.yuurei/yuurei.yaml`, one profile
(`profiles/claude-basic/profile.yaml`), and one safe task
(`tasks/hello.md`). It never overwrites existing files and creates no
credentials. Pass options to change the runtime, profile, task, run, or
target directory:

```sh
yuurei init --runtime codex --profile codex-basic --task hello --run first-run
yuurei init ../other-project
```

The default profile is `claude-basic` and the default task is `hello`. Pass
`--runtime opencode` or `--runtime codex` to scaffold for another runtime.
The named run resolves `profile` and `task` from `.yuurei/yuurei.yaml`:

```sh
yuurei profile list
yuurei inspect claude-basic
yuurei run hello
```

To choose both values at the command line, run:

```sh
yuurei run --profile claude-basic --task .yuurei/tasks/hello.md
```

After a run, use the printed run ID to inspect the result:

```sh
RUN_ID='<run-id>'
yuurei trace show "$RUN_ID"
cat ".yuurei/runs/$RUN_ID/trace.json"
cat ".yuurei/runs/$RUN_ID/stdout.log"
cat ".yuurei/runs/$RUN_ID/stderr.log"
cat ".yuurei/runs/$RUN_ID/artifacts.json"
```

The trace records the runtime, exit status, timeout status, the requested-cell
digest that identifies the cell, profile and task digests, and isolation result.
Yuurei does not copy your project source into
the temporary execution cell, and it does not import your global runtime
configuration automatically.

The `task` path in a named run must stay inside `.yuurei/`. A direct
`--task` path is an explicit operator choice and may point elsewhere. Keep
profile and task files trusted because the runtime executes their contents.

For runtime-specific authentication, config files, isolation levels, and
security details, read the [Getting started guide](https://github.com/shimpeiws/yuurei/blob/main/docs/getting-started.md).

`yuurei doctor` also reports isolated temp directories orphaned by an abnormal
termination (SIGKILL, power loss, hard crash); `yuurei clean` removes them.

```sh
yuurei init [--runtime <runtime>] [--profile <name>] [--task <name>] [--run <name>] [directory]
yuurei doctor
yuurei profile list
yuurei inspect <profile-name>
yuurei run <run-name>
yuurei run --profile <profile> --task <path/to/task.md>
yuurei run <run-name> --keep
yuurei run <run-name> --bridge-codex-auth-file
yuurei run <run-name> --bridge-opencode-auth-file
yuurei trace show <run-id>
yuurei clean
```

## Exit codes

`yuurei` exits with a code that maps a failure to the stage that produced it:

| Code | Meaning                          |
| ---: | -------------------------------- |
|    0 | Execution succeeded              |
|    2 | Configuration error              |
|    3 | Runtime not found or unsupported |
|    4 | Isolation verification failed    |
|    5 | Runtime execution failed         |
|    6 | Trace or artifact save failed    |

A run killed by a signal uses the shell convention: 130 for `SIGINT` and 143 for
`SIGTERM`. With `--json`, an error also emits a `{"level":"error",...}` line
before the process exits.

## Status

Scope: single-runtime "native cell" execution (Pattern A) for Claude
Code, Codex, and OpenCode, treated as independent runtime × model × harness
× task combinations. The OpenCode adapter was added later (issue #106) and,
like the others, is exercised against the real runtime in CI. Not yet in scope:
cross-runtime harness portability, local
LLM support, output quality auto-scoring, cost/ROI dashboards, OS-level
sandboxing, or team auth.

## Learn more

See the
[design document](https://github.com/shimpeiws/yuurei/blob/main/docs/design/yuurei-design-v0.3.md)
for the full design, the
[release process](https://github.com/shimpeiws/yuurei/blob/main/docs/releasing.md),
and — when moving from 0.x —
[the 0.x to 1.0 migration guide](https://github.com/shimpeiws/yuurei/blob/main/docs/migration-0.x-to-1.0.md).
