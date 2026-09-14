# yuurei

Isolated, reproducible runtime environments for coding agents (Claude Code, Codex).
A CLI that builds a temporary execution cell per run, executes a runtime inside it,
and emits a runtime-agnostic `trace.json`.

Full design: [`docs/design/yuurei-design-v0.3.md`](docs/design/yuurei-design-v0.3.md).
Section references below (§9.1 etc.) point into that document, which is authoritative.

## Commands

```sh
pnpm test              # vitest run
pnpm run check         # oxlint --deny-warnings
pnpm run format        # oxfmt --check
pnpm run build         # tsc --build (type check)
pnpm run knip          # unused exports
```

Prefer targeted test files over the full suite locally (`pnpm test <path>`);
this machine is memory-constrained. CI runs everything.

## Trust boundary

This tool bridges credentials into an environment where a coding agent executes.
That makes the boundary sharper than for a typical CLI:

**Trusted:** the operator running `yuurei`, and the repository's own source.

**Not trusted:**

- **Profile content** — config files, hooks, and settings materialized into the
  isolated config dir. The runtime _executes_ these. Once credential bridging is
  on, anything a profile's hooks or settings can run reaches the bridged
  credential (§9.2). Profiles and tasks must be trusted the same way executable
  code is; the code must not widen what a profile can reach.
- **Task files** — same reasoning.
- **Agent stdout/stderr** — may contain secrets, and is read back for usage
  parsing and persisted as logs.
- **Files inside the cell** — created by the agent under execution, including
  symlinks. Anything that reads or rewrites them is a path that leads outward.

## Invariants

These are guarantees the implementation is expected to uphold. A change that
breaks one is a defect, not a tradeoff.

This list is a summary for working in the repository. The normative wording is
Section C of [`docs/contract.md`](docs/contract.md); when the two differ, that
document is right.

- Never rename, move, or delete the user's real global config
  (`~/.claude`, `~/.codex`) (§9.1, §2.3).
- Never copy credentials into a profile; never record secrets in the trace
  (§9.2, §10.2). Strip tokens, cookies, API keys and auth headers from logs.
- A profile must not be able to redirect authentication to the operator's shared
  OS credential store — the adapter forces the credential-storage backend at the
  highest-precedence layer, whatever a materialized profile's config asks for (§9.2).
- The temp cell is removed after the run, and as far as possible on
  `SIGINT`/`SIGTERM` (§9.1). Only `SIGKILL`/hard crash may bypass it; that is
  left to the orphan-recovery sweep.
- `--keep` preserves config and logs for debugging, **never credentials** —
  credential material written to disk is scrubbed on cleanup even under
  `--keep` (§9.2).
- If isolation verification fails, the runtime is not started (§12.2).
- Path validation, isolation verification, and credential bridging fail closed:
  a failure never falls back to "allow". Credential bridging failing leaves the
  run _unauthenticated_ rather than aborting — that is deliberate (§12.2), and
  is not the same as failing open.

## Out of scope (§12.1)

v0.3 deliberately does **not** defend against these. When reviewing, do not
raise them as findings; if they are relevant, name them as accepted risks:

- Malicious OS operations performed by the code under execution.
- Vulnerabilities in the runtime (`claude`, `codex`) itself.
- Network-based attacks.
- Complete process/filesystem isolation — isolation is at the
  configuration/environment level (Level 0–1), not a security boundary against
  malicious code (§9.3).
- Concurrent adversarial mutation of profile/task files during materialization:
  `isPathWithin` is check-then-read, not atomic, so a filesystem actor racing
  the check is explicitly out of scope.

## Security review

Repo-wide audits use the read-only `security-auditor` subagent
(`.claude/agents/security-auditor.md`); the latest report lives in
`docs/security/`. Per-change review uses `/security-review`, which is scoped to
the pending changes on the current branch. The policy for when `/security-review`
is required or recommended lives in `docs/security/review-policy.md`.
