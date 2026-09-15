# 0015. Enumerate runs through the CLI, not the run directory

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

`yuurei` writes one run directory per execution under `.yuurei/runs/<run-id>/`,
but offers no way to enumerate them. `yuurei trace show <run-id>` assumes the
caller already holds the run id, and the id is only ever printed once, on the
`run` command's own output. A tool built on top of yuurei therefore has to walk
`.yuurei/runs/` and reconstruct the naming and layout itself.

That inverts the intended dependency. §11 puts the upper layer behind the CLI and
the trace, not the file tree; §18 repeats it. A consumer that reads the directory
layout depends on a detail the project never promised to keep, and the run
directory's internal shape (which files exist, how they are named) becomes a
de-facto interface by accident.

The CLI already has `yuurei profile list` for profiles. Runs, the thing the tool
actually produces, have no equivalent.

## Decision

Add a top-level command, **`yuurei runs`**, that lists the runs under the current
project's `.yuurei/runs/`.

### The name

It is a new top-level noun, alongside `doctor` and `clean`. Two alternatives were
rejected:

- **`yuurei run list`.** The existing `run [run-name]` command would read `list`
  as a run name and execute it. Disambiguating would mean reworking how `run`
  parses, a breaking change to a Section A command, for a naming preference.
- **`yuurei trace list`.** It lists runs, not traces; the name would describe the
  storage the rows are read from rather than the rows themselves.

### The output

`--json` emits **one JSON object per line**, one per run, matching the existing
`--json` contract (an object per line, command-specific fields at the top level).
Rows are the `info` lines that carry a `run_id`; a skipped directory is reported
through the logger's `warn` channel, which the same contract renders as a `warn`
line. The human-readable form is a one-line summary per run; only `--json` is a
contract.

Each row is a **fixed projection of the run's trace**. It carries exactly these
fields, mirroring the trace's names and nesting:

```jsonc
{
  "run_id": "20260915T080102Z-a3f9",
  "started_at": "...",
  "finished_at": "...",
  "runtime": { "id": "claude-code" },
  "model": { "requested": "sonnet" },
  "profile": { "name": "claude-basic" },
  "task": { "source": ".yuurei/tasks/hello.md" },
  "isolation": { "strategy": "level1" },
  "execution": { "exit_code": 0, "signal": null, "timed_out": false },
  "requested_cell": { "digest": "sha256:...", "inputs_version": 1 },
}
```

The row is closed: a field added to the trace later does **not** appear in it
unless this contract is changed, and extending the row is an additive change. A
field that is absent from a trace (the optional `requested_cell` on a run written
before v0.3.0, for example) is **absent** from the row too, never `null`:
absence means unknown, and the index does not invent a value (§6.3, ADR-0009).

Runs are read with the same reader as `trace show` (`readTrace`), so any trace
carrying the current `0.3` compatibility token parses, whatever build wrote it. A
trace whose `schema_version` is not `0.3` does not parse and its run is skipped,
exactly as a corrupt one would be.

### Ordering and discovery

Rows are ordered by **ascending lexicographic `run_id`**. The id is a UTC
timestamp plus a suffix, so this is chronological and deterministic; the command
is enumeration, not ranking (§11), and it does not sort by any outcome.

Discovery reads the entries of `.yuurei/runs/`. Only directories are considered
(never symlinks, mirroring the orphan sweep's guard). A directory is skipped when:

- its `trace.json` is missing or does not parse, or
- `basename(runDir) !== trace.run_id`.

An entry without a valid, self-consistent trace is not a run: `trace.json` is the
completion marker, and the pipeline removes a directory that never reached it.
The equality check keeps the row's `run_id` from being one of two disagreeing
values.

A skip is reported through the logger's `warn` channel as one fixed line,
`runs: <n> invalid run director(ies) skipped`, aggregated across the command and
never carrying the directory name, the trace's `run_id`, or the parse error text.
Directory names and `run_id`s are chosen outside this command and can carry a
secret; this is the same rule the trace's `diagnostics` follow (§20.7). A
filesystem actor racing the enumeration, swapping a directory for a symlink
between the check and the read, is **out of scope** under §12.1, as it already is
for profile materialization; the guarantee is about a tree that is not being
mutated underneath the command.

## Consequences

- The run directory stops being an implicit interface for enumeration. A consumer
  can discover runs through the CLI, which is the point of the milestone.
- The row shape is part of the stable contract. Adding a field is additive (a
  minor release); removing or renaming one is breaking (a major). It is closed by
  design, and carries only trace fields.
- A consumer that needs a field the row omits still has `trace show`. #141 makes
  its `--json` form the complete trace, so the two commands together cover both
  discovery and full detail without touching the file tree.
- Skipping an unreadable or inconsistent directory makes the index a view of
  _complete_ runs, not of everything physically present. A corrupt run is
  invisible except for the warning. This is accepted: emitting a row of unknowns
  would make every consumer handle a partial record the project never promised.
- Rows and warnings share the `--json` stream, distinguished by `level`, as the
  contract already does for every command. A consumer that wants only rows
  filters on `level === "info"`.
- One more Section A surface to keep. It is read-only and derived, so the
  maintenance cost is a stable shape rather than behaviour to preserve.
