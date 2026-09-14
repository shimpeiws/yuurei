# Security review — OpenCode runtime adapter (issue #106)

- **Date:** 2026-09-14
- **Base commit:** `5febb8d` (working-tree changes on `main`, uncommitted)
- **Scope:** the pending diff for the OpenCode runtime adapter — new
  `src/runtime/opencode/` (`index`, `args`, `paths`, `auth`, `config-guard`,
  `jsonc`, `path-safety`), the trace schema extension
  (`model.resolved_reason`, `diagnostics`), `run/pipeline.ts`,
  `cli/trace-show.ts`, `registry.ts`, and the `--bridge-opencode-auth-file` CLI
  flag.
- **Tool:** Claude Code built-in `/security-review` (`claude -p
"/security-review"`, Claude Code 2.1.270), scoped to the pending changes.
- **Policy:** this is the **required** per-change review for the first working
  implementation of a new runtime adapter
  (`docs/security/review-policy.md` → Trigger points → Required).
- **Outcome:** **Approved — no exploitable vulnerabilities found.**

## Run 1 — one finding, fixed

**Finding:** `~`-in-`{file:}` guard bypass when `HOME` is unset —
`src/runtime/opencode/index.ts` (Medium, confidence 8/10).

`homeDir` for the guard was `isolation.env['HOME'] ?? configRoot`. When the
parent process has no `HOME` (systemd unit, container entrypoint, `env -u HOME`),
the guard expanded `{file:~/...}` to an in-cell path and allowed it, while
OpenCode resolves `~` through the passwd entry — the operator's real home — and
would read the real credential store.

**Fix:** the adapter now passes `isolation.env['HOME'] ?? null`, and the guard
refuses every `~` reference when HOME is absent rather than expanding to a path
that diverges from what the runtime will read
(`src/runtime/opencode/config-guard.ts`, `expandHome`). Added unit and
integration coverage (level0, HOME unset).

## Run 2 — no findings

Re-run against the fixed diff:

> No exploitable vulnerabilities found.

Confirmed surfaces (verbatim summary from the review): `{file:...}` containment
via a JSONC parser that decodes escapes before scanning; literal `apiKey`
rejection including duplicate-key bypasses; symlink-safe, fail-closed auth-file
bridge; `spawn` with an args array (no shell interpolation); full XDG/TMPDIR
redirection with project-config and external-skill loading disabled; credential
env forwarding through an explicit allowlist.

## Non-findings / accepted risks (per design doc §12.1)

- macOS managed config and remote `.well-known/opencode` (trusted, admin- or
  org-controlled; recorded in §12.1).
- The check-then-read TOCTOU on the auth-file symlink check (concurrent
  adversarial filesystem mutation is out of scope, §12.1).
- `extractOpenCodeAuthSecrets` is best-effort redaction over the runtime's own
  auth file shape.
