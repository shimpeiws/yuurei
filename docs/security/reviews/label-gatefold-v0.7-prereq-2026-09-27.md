# Security review — gatefold-v0.7-prereq (issues #194, #193, #190)

- **Date:** 2026-09-27
- **Head commit:** `bef1710` (branch `label-gatefold-v0.7-prereq-agent`, diff
  against `origin/main`)
- **Scope:** the branch diff — usage-key normalization and observed-cost
  handling in `src/runtime/{claude-code,codex,opencode}/index.ts`,
  `src/run/pipeline.ts` (runtime-reported cost precedence, `result.txt`
  persistence), `src/runtime/types.ts`, `src/cost/types.ts`,
  `src/trace/schema.ts`, `src/run/layout.ts`, `src/artifact/collector.ts`.
- **Tool:** manual per-change review against the invariant checklist in
  `docs/security/review-policy.md` (the `/security-review` slash command is a
  Claude Code feature and was not available in this environment; the policy's
  scope list was applied to the diff directly).
- **Policy:** a manual review is **required** for changes touching
  `src/runtime/` (`docs/security/review-policy.md` → Trigger points →
  Required). A maintainer-run `/security-review` should still complete before
  merge.

## Outcome: no invariant-breaking findings

Checked against each invariant in `CLAUDE.md` / Section C:

- **Real `~/.claude` / `~/.codex` never renamed, moved, or deleted.** No
  change touches the real global config paths; the credential-bridge code
  paths (`bridgeCodexAuthFile`, `bridgeCodexApiKey`,
  `bridgeOpenCodeAuthFile`) are untouched.
- **No secrets in the trace; logs/artifacts redacted.** The final result text
  is runtime output and is treated exactly like a log: redacted and capped in
  memory through the same redact-and-cap pipeline as `redactFile`
  (`redactText`), written to a temp output in the run directory, and
  published via `rename` — an unredacted or partial file can never become
  `result.txt`, and no unredacted copy is ever written to disk (the same
  applies to `patch.diff`). The text is never placed in `trace.json`; only
  the artifact entry (`path`, `kind: "result"`, digest) reaches the trace.
  Covered by `test/integration/run-pipeline.test.ts` ("persists the runtime
  result as a redacted result.txt artifact, never inlined").
- **Diagnostics stay fixed-string.** The new diagnostics (`result: no final
message emitted`, `result: final message could not be parsed`,
  `result: save failed; result.txt not recorded`) carry no runtime text and
  no paths, matching the existing patch/workspace convention.
- **Credential backend / profile boundaries.** Unchanged — no new config or
  env surface is forwarded into the cell.
- **Cleanup.** `result.txt` lives in the durable run directory, not the cell;
  the already-redacted output temp is removed in a `finally` on every path,
  and a run interrupted before `writeTrace` still has its run directory
  removed by the existing cleanup. No unredacted staging temp exists — the
  patch and result are redacted in memory — so a hard kill can strand only
  redacted content (ADR-0016).
- **Fail-closed paths.** Unchanged — no path validation, isolation
  verification, or bridging logic was modified. The adapters only read
  `result.stdoutPath`, a path the pipeline created inside the cell; the new
  `layout.resultPath` is a fixed name inside the run directory.
- **Requested-cell digest.** Observed output (usage, cost, model, result)
  enters the trace only; `src/cell/digest.ts` and the digest input set are
  untouched.

## Notes (non-findings)

- `result.txt` redaction is the same best-effort text pass as the logs — a
  secret the runtime prints in a shape outside the known values and generic
  patterns is recorded, which is already the accepted posture for
  `stdout.log`/`stderr.log` (contract, Section D).
- A runtime-reported `cost.amount` is trusted as a finite number only; no
  bound is enforced, same posture as `usage` figures.
