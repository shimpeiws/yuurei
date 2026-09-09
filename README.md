# yuurei

> Isolated, reproducible runtime environments for coding agents

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

Start with the [Getting started guide](docs/getting-started.md) to create
your first project configuration, profile, and task, then inspect the
resulting trace and logs.

```sh
yuurei doctor
yuurei profile list
yuurei inspect <profile-name>
yuurei run <run-name>
yuurei run --profile <profile> --task <path/to/task.md>
yuurei run <run-name> --keep
yuurei trace show <run-id>
```

## Status

v0.3 scope: single-runtime "native cell" execution (Pattern A) for Claude
Code and Codex, treated as independent runtime × model × harness × task
combinations. Not yet in scope: cross-runtime harness portability, local
LLM support, output quality auto-scoring, cost/ROI dashboards, OS-level
sandboxing, or team auth.

## Learn more

See [`docs/design/yuurei-design-v0.3.md`](docs/design/yuurei-design-v0.3.md)
for the full design document.
