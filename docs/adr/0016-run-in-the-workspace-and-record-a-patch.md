# 0016. Run each cell in its workspace, and record the result as a patch

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

The run layout declares `patchPath` (`patch.diff`) and creates `workspaceDir`
(`workspace/`), and §10 lists both in `.yuurei/runs/<run-id>/`. Neither is used:
`patch.diff` is never written, nothing references `patchPath` outside the layout
module, and `workspace/` is created empty and left that way. The design document
promises an artifact the implementation does not produce, which is the worst
state for a reader: they expect the file to exist.

The reason is structural, not an oversight. The runtime's working directory is
the isolation cell (`isolation.rootDir`), a temp directory that is disposed when
the run ends. Nothing durable holds what the agent produced, so there is nothing
to take a patch against. The design's own "fresh temporary workspace per
execution" (§3.1) was never connected to the `workspace/` directory it named.

Four properties become part of the public contract the moment an artifact is
produced, and none can be changed later without a breaking release: the base the
diff is taken against, which files are in scope, what happens when generation
fails, and how an empty diff is represented. No project source is copied into the
cell (the design and the README both say so), so the base is empty by
construction. That settles the first property and makes the others answerable
without inventing a project-copy model.

## Decision

### The runtime runs in a fresh workspace inside the temporary cell

The runtime's working directory is `<cell>/workspace`, a fresh directory the
isolation step creates inside the temp cell. The rest of isolation is unchanged:
the config and credential roots, the temporary `HOME` under level1, and the
environment allowlist all still point into the cell.

The cell workspace is **not** the durable one. After the run, the pipeline copies
what it holds into `<runDir>/workspace/`, and that copy is the durable record and
the base for the patch.

**Why not run directly in `<runDir>/workspace`.** Making the durable run
directory the working directory would put the agent inside the project for the
whole run. Two costs follow, and neither is acceptable for the isolation premise.
The agent could write to the run directory while executing, including the paths
the pipeline writes its own outputs to. And its cwd would be under the project,
so it could discover project files and ancestor configuration, which is exactly
the "only the specified profile" guarantee this tool exists to make; no runtime
adapter enforces against that today (only OpenCode disables project config, §20.2,
and that is a separate guarantee). Running in a temp workspace keeps the cwd
outside the project, which is what "a fresh temporary workspace per execution"
already meant.

### The durable workspace is a no-follow copy

After execution, the pipeline walks the cell workspace and copies it into
`<runDir>/workspace/`, preserving each file's relative path and content bytes.
Symlinks are **not followed and not copied**, and only regular files are copied;
directories are recreated to hold them. Every other file type (FIFO, socket,
device) is skipped. The copy never follows a symlink out of the workspace.

The copy preserves content only. It does not promise mode, executable bit, owner,
or mtime, and the patch (below) cannot represent them. An executable the agent
wrote is copied, but its bit is not recorded as part of the contract.

**The guarantee is about symlinks on a static tree.** Two cases sit outside it,
and both are accepted risks under §12.1:

- A filesystem actor that races the check, swapping a regular file for a symlink
  between the check and the read. This is the same check-then-read race that
  profile materialization already accepts.
- **Hard links.** A hard link to an inode outside the workspace is a regular file,
  so it is copied and its content is recorded. Detecting it needs hard-link
  detection or filesystem isolation, which v0.3 does not provide.

The guarantee is stated as "does not follow symlinks on a tree that is not being
mutated underneath the copy", not as "never reads outside the workspace", because
the latter is not true.

### The base is the empty workspace

The durable workspace starts with nothing copied in, so every regular file in it
after the copy is a **new file**, and `patch.diff` is an all-additions diff. There
is no project copy to diff against, and introducing one would change what yuurei
is (it would execute against the operator's source); that is a larger decision
than this record.

### Diff format

`patch.diff` is a UTF-8, LF-terminated unified diff against the empty base:

- `--- /dev/null` and `+++ <path>` headers, with `<path>` relative to the
  workspace root and using forward slashes.
- One hunk per non-empty file, `@@ -0,0 +1,N @@`, each content line prefixed with
  `+`.
- An **empty regular file** is represented by its headers alone, with no hunk.
  (The separate case of a workspace with no in-scope files is an empty
  `patch.diff`, below.)
- The `\ No newline at end of file` marker when the stored file does not end in a
  newline. The diff as a whole ends in a newline.
- Line splitting is on LF, and a trailing CR is kept in the line content: a CRLF
  file is not normalized, so the patch reflects the bytes the agent wrote.
- A file is treated as **binary and skipped** when its bytes contain a NUL byte or
  are not valid UTF-8. It stays in the workspace; only the patch omits it.
- A file is **skipped** when a component of its relative path cannot be
  represented unambiguously: when that component's bytes are not valid UTF-8, or
  contain a NUL, LF, CR, TAB, or backslash. The file stays in the workspace.
- A file larger than the effective artifact size cap (`maxArtifactBytes`, default
  `DEFAULT_ARTIFACT_MAX_BYTES`, 1 MiB) is **skipped** for the same reason the
  collector caps artifacts: diffing reads the whole file, and a single huge file
  must not cost unbounded memory. It stays in the workspace.

The patch is capped in total as well: files are added in order until the next one
would take the patch past `maxArtifactBytes`, at which point the rest are skipped
and counted. The artifact collector then caps the stored bytes as it does for a
log; if it truncates the patch, `truncated: true` is set and the stored bytes are
**not** a complete unified diff, so a consumer must not parse a truncated patch as
valid.

Files are diffed in ascending order of the **UTF-8 byte sequence** of their
relative path, so the same workspace produces the same `patch.diff` byte for
byte, independent of locale and filesystem enumeration order.

Git-style `diff --git` headers are not used, so no `git` binary is required and
the output stays a plain unified diff.

### Empty diff

`patch.diff` is created whenever generation succeeds; with no in-scope files it
is an empty file. Its presence is then uniform, so a consumer never has to decide
whether a missing file means "no changes" or "the feature did not run". A missing
`patch.diff` always means generation did not succeed, and the trace's diagnostic
says why.

### Order, failure, and the completion marker

The pipeline performs these steps in order, identically under `--keep`:

1. the runtime exits;
2. copy the cell workspace into the durable workspace;
3. generate and redact `patch.diff`;
4. write `artifacts.json`;
5. write the remaining durable outputs;
6. write `trace.json` last;
7. scrub credentials and dispose the isolation cell.

Copy and patch generation are **best-effort**. On failure the run does not fail:
`patch.diff` is left absent, a **fixed-string** diagnostic is recorded in the
trace, and steps 4-6 still run. If the copy fails partway, the durable workspace
holds what was copied but `patch.diff` is not generated, because a patch of a
partial tree would be a wrong record rather than a partial one. A hard resource
failure (the machine kills the process) is outside what best-effort can cover,
and is not promised.

**This narrows what `trace.json` means, and the contract is updated with it.**
`trace.json` still means the run reached its end and the identity-and-outcome
record is complete; it no longer claims that every best-effort artifact was
produced. That claim was already inaccurate (a truncated log is a successful
run), and best-effort artifacts need a marker that can be absent. A consumer
reads `artifacts` for which artifacts are present and `diagnostics` for why one
is not. The **required** durable outputs are `stdout.log`, `stderr.log`,
`artifacts.json`, `resolved-profile.json` and `trace.json`: a failure to write any
of them removes the run directory, as it does today. Only the workspace copy and
`patch.diff` are best-effort, and their failure leaves the trace in place.

### Diagnostics carry no agent-controlled text

A skipped file, and a failed copy or patch, is reported as a **fixed string**,
never with the path. Paths under the workspace are chosen by the code under
execution and can carry a secret in a filename; the trace must not record them.
This matches the rule already applied to the OpenCode adapter's diagnostics
(§20.7): only fixed strings reach `diagnostics`.

The strings are fixed, so a consumer can classify without parsing paths:

- `workspace: <n> symlink(s) skipped`
- `workspace: <n> special file(s) skipped`
- `workspace: copy failed; durable workspace may be incomplete`
- `patch: <n> binary file(s) omitted`
- `patch: <n> oversized file(s) omitted`
- `patch: <n> unrepresentable name(s) omitted`
- `patch: <n> file(s) omitted over the total cap`
- `patch: generation failed; patch.diff not recorded`

A skip category with no entries is omitted, and its count is its only variable. A
failure sentence appears only when the failure occurred, and carries no count.

### Redaction

`patch.diff` is text, so it is passed through the same best-effort
known-credential-value redaction as `stdout.log` and `stderr.log` before it is
stored. The digest in `artifacts.json` covers the bytes **as stored**, after that
pass, as it already does for the logs.

The files inside `workspace/` are stored **as the agent produced them and are not
scrubbed**. A coding agent can write anything there, including a secret it was
given or generated; redacting arbitrary files is neither reliable for binary
content nor meaningful for the agent's actual output. This is an accepted risk,
stated in the contract, not a guarantee.

### Recording

`patch.diff` is collected as an artifact, so it appears in `artifacts.json` (with
`kind` `patch`, derived from the `.diff` suffix) and in the trace's artifact list,
written before `trace.json` as every durable output is. Its absence, with the
matching diagnostic, is how a consumer knows the patch was not recorded.
`workspace/` is a directory and is not an artifact entry.

### `--keep` keeps its meaning

`--keep` still governs the isolation cell only. `workspace/` and `patch.diff`
live in the run directory and persist regardless, like the logs.

## Consequences

- §10's run-directory layout is now produced, and `patch.diff` moves from the
  contract's best-effort section to the stable surface. An upper layer can read
  the agent's output as a patch instead of diffing a directory tree itself.
- Because the base is empty, the patch shows only what the agent created. It
  cannot show a change to a file the operator supplied, because none is supplied.
  A future design that seeds the workspace supersedes this record; it does not
  edit it.
- The patch is not a round-trippable snapshot: it carries content and paths only,
  not mode, executable bit, owner, mtime, or empty directories. A consumer that
  needs those reads the workspace, and the contract says which the patch omits.
- The completion-marker wording is narrowed. `trace.json` no longer asserts that
  every artifact was produced; it asserts that the run finished and its record is
  complete. That is weaker than the previous sentence and stronger than the
  alternative of omitting the trace on a best-effort failure, which would discard
  the run's outcome over a debugging convenience.
- **The workspace is uncapped.** Logs and artifacts have a size cap; the
  workspace does not, because it is the agent's primary output rather than a
  duplicate. A run that writes a very large tree fills the run directory. The
  patch is capped per file and in total, but the workspace holding the files is
  not. If this becomes a problem, a workspace cap or quota is an additive contract
  change, not a change to this decision.
- **A secret the agent writes to `workspace/` is recorded as produced.** This
  narrows "secrets are never recorded" to a trace-only guarantee plus a
  best-effort redaction of the patch text. It is the cost of recording the agent's
  real output, and it is named in the contract rather than left to be discovered.
- The patch's stored bytes can differ from the workspace (redaction), exactly as
  the logs already can. The digest attests to the stored bytes, and the contract
  says so.
- The design document and `getting-started.md` describe the current behaviour and
  must be updated by the implementation, not by this record: design §3.1, §8
  (the CLI example lacks `yuurei runs`), §9.1, §10 (including §10.2, which still
  says secrets generated by the runtime are not recorded), §20.2, §20.3, and the
  getting-started / manual-verification guides. The implementation must also
  confirm the `runPipeline` dispose order, every adapter's cwd, the test
  runtimes' workspace output, and the `artifacts.json` write order.
