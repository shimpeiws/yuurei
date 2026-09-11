# yuurei

> Isolated, reproducible runtime environments for coding agents

![Yuurei ghost DJ operating a mixing console](docs/assets/yuurei-top.jpg)

`yuurei` isolates coding-agent runtime environments (Claude Code, Codex)
from your normal global configuration, so different harness profiles
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

## Quickstart

Install yuurei from npm, or build it from a source checkout:

```sh
npm install -g yuurei
```

Check that the CLI is on your PATH:

```sh
yuurei --help
```

### Required authentication setup

`yuurei` forwards explicit credential variables into the isolated runtime. It
does **not** read your interactive login from the OS credential store.

**Claude Code (subscription login):** Run `claude setup-token` once in this
shell to obtain a long-lived token, then export it before running any task:

```sh
claude setup-token
# follow the prompts, then copy the token it prints
export ANTHROPIC_AUTH_TOKEN='<token from claude setup-token>'
```

Verify the variable is set without printing its value:

```sh
[ -n "$ANTHROPIC_AUTH_TOKEN" ] && echo present || echo absent
```

Note: `claude auth status` may report `loggedIn: true` while `yuurei doctor`
reports `authUsable: false`. These check different stores — `claude auth status`
reads the OS credential store; yuurei checks for an explicit environment
variable. A shell export applies only to that shell and its child processes; do
not persist the token in a profile, task, or committed file.

**Claude Code (API key):** export `ANTHROPIC_API_KEY` instead.

**Codex:** export `OPENAI_API_KEY`.

Check that the environment is ready:

```sh
yuurei doctor
```

Look for `authUsable: true` for the runtime you plan to use. If `authUsable`
is `false`, `yuurei doctor` will print runtime-specific next steps.

### Create a first project

A Yuurei project keeps its configuration under `.yuurei/`. The project
configuration names profiles and runs. A profile selects a runtime and its
runtime-native config files. A task is the instruction sent to that runtime.
Each run creates a trace and logs under `.yuurei/runs/<run-id>/`.

Create the smallest Claude Code project:

```sh
mkdir yuurei-demo
cd yuurei-demo
mkdir -p .yuurei/profiles/claude-basic/config .yuurei/tasks

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

cat > .yuurei/profiles/claude-basic/profile.yaml <<'YAML'
runtime: claude-code
YAML

cat > .yuurei/tasks/hello.md <<'MARKDOWN'
Reply with "Hello from yuurei." Do not read or write files or run commands.
MARKDOWN
```

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

The trace records the runtime, exit status, timeout status, profile and task
digests, and isolation result. Yuurei does not copy your project source into
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
yuurei doctor
yuurei profile list
yuurei inspect <profile-name>
yuurei run <run-name>
yuurei run --profile <profile> --task <path/to/task.md>
yuurei run <run-name> --keep
yuurei trace show <run-id>
yuurei clean
```

## Status

v0.3 scope: single-runtime "native cell" execution (Pattern A) for Claude
Code and Codex, treated as independent runtime × model × harness × task
combinations. Not yet in scope: cross-runtime harness portability, local
LLM support, output quality auto-scoring, cost/ROI dashboards, OS-level
sandboxing, or team auth.

## Learn more

See the
[design document](https://github.com/shimpeiws/yuurei/blob/main/docs/design/yuurei-design-v0.3.md)
for the full design, and the
[release process](https://github.com/shimpeiws/yuurei/blob/main/docs/releasing.md).
