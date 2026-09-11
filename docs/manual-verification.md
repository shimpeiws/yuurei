# Manual verification guide

This guide documents hands-on checks that automated tests cannot cover, such
as running against a real installed runtime. Each section states what it
verifies and provides exact copy-paste commands with expected outcomes.

> **Runtime requirement:** sections marked _(requires runtime)_ need
> `claude` or `codex` installed and authenticated. Sections that exercise
> rejection paths require no runtime.

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
