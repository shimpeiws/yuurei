# Security Review Policy

This policy defines **when** a manual `/security-review` is required or
recommended, **what** it checks, and **where** findings are recorded. It is the
human-in-the-loop layer of the security workflow and complements the automated
scanners (Semgrep, CodeQL, Gitleaks, Dependabot) described below.

## Automated scanning layers

These run in CI without a human in the loop. They are not a substitute for the
review layers below: a scanner checks for known-bad shapes, while the review
checks whether this repository's invariants still hold.

| Tool       | Workflow         | When                              | What it is for                                                                                            |
| ---------- | ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Semgrep    | `semgrep.yml`    | Every PR and push to `main`       | Fast pattern matching, seconds of feedback                                                                |
| CodeQL     | `codeql.yml`     | Every PR, push to `main`, nightly | Semantic dataflow analysis over `javascript-typescript` and `actions`, with the `security-extended` suite |
| Gitleaks   | `gitleaks.yml`   | Every PR and push to `main`       | Secrets in the diff and in history                                                                        |
| Dependabot | `dependabot.yml` | Weekly                            | Dependency and action updates                                                                             |

The split between Semgrep and CodeQL is deliberate: Semgrep gives quick
feedback on every change, CodeQL adds the deeper analysis that catches flaws a
pattern cannot see. CodeQL also runs **nightly** because its queries and
bundled databases change independently of this repository — a scheduled run
finds what a newly shipped query would flag in code nobody has touched.

CodeQL uses **advanced setup** (a committed workflow), not GitHub's default
setup. The two are mutually exclusive: enabling default setup in repository
settings makes the committed workflow fail. Keep the workflow as the source of
truth so the query suite, languages, and schedule are reviewable in the diff.

Findings from both Semgrep and CodeQL surface as SARIF under
**Security → Code scanning alerts**.

## Two review layers

| Layer             | Tool                                                               | Scope                                                                   | When                                               |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Repo-wide audit   | `security-auditor` subagent (`.claude/agents/security-auditor.md`) | Whole codebase against the invariants in `CLAUDE.md` and the design doc | Periodically; the report lives in `docs/security/` |
| Per-change review | `/security-review`                                                 | Pending diff on the current branch only                                 | On this policy's trigger points, below             |

`/security-review` is scoped to the **pending changes on the current branch**.
It is not a substitute for a repo-wide audit, and a repo-wide audit does not
substitute for per-change review: the two catch different regressions.

## Trigger points

### Required

A manual `/security-review` is **required** before merging any change that
touches:

- `src/isolation/` — isolation construction, environment allowlist, temp-dir
  and config-root handling, orphan sweep
- `src/runtime/` — credential bridging (`bridgeClaudeCredentials`,
  `bridgeCodexApiKey`, `auth.json`), launch arguments, environment forwarding,
  stdout/stderr capture
- `src/cell/` — cell resolution and digesting, where profile and task content
  becomes an executable configuration
- Any other code that crosses or redefines the trust boundary described in
  `CLAUDE.md` (e.g. new env vars forwarded into the cell, new read or write
  paths over cell files)

A manual `/security-review` is also **required** for the first working
implementation of any new runtime adapter. The adapter is a new attack surface:
it materializes untrusted profile content, forwards environment, and bridges
credentials. It must be reviewed before it ships, even when the runtime itself
is still experimental.

### Recommended

A manual `/security-review` is **recommended** for:

- Changes touching profile materialization, task file handling, or log/trace
  output (redaction, artifact collection, trace writing)
- Before any release tag

These areas can weaken guarantees without an obvious isolated defect, so a
second look is cheap insurance. If the change is a one-line formatting fix in
these files, use judgment; the review exists to catch intent-level mistakes, not
to add ceremony.

### Not required

Trivial, non-security changes (docs that do not describe security behavior,
renames with no behavior change, formatting) do not need a manual review. When
in doubt, run it; the review is read-only and scoped to the branch diff.

## Scope

The reviewer checks the **invariants from `CLAUDE.md`** against the diff:

- The user's real global config (`~/.claude`, `~/.codex`) is never renamed,
  moved, or deleted
- Credentials are never copied into a profile; secrets never land in the trace
  or logs (tokens, cookies, API keys, auth headers are stripped)
- A profile cannot redirect authentication to the operator's shared OS
  credential store — the adapter forces the storage backend at the
  highest-precedence layer
- The temp cell is removed after the run and on `SIGINT`/`SIGTERM`;
  `--keep` preserves config and logs but never credentials
- Isolation verification failures stop the runtime from starting
- Path validation, isolation verification, and credential bridging fail closed;
  a failure never falls back to "allow"

The review is **not** a generic style or checklist pass: the repo already
defends against the obvious classes (path containment, `spawn` without
`shell:`), and the review's job is to confirm the _specific_ invariant above
survives the change.

The reviewer must distinguish the invariants from the **non-goals** in §12.1 of
the design doc. Malicious OS operations, runtime vulnerabilities, network-based
attacks, and full process/filesystem isolation are accepted risks, not
findings.

## Record-keeping

Findings and the outcome of each manual review are recorded in `docs/security/`,
following the existing convention. A per-change review does not require a
persisted report file for every branch; instead:

- **Blocking findings** must be resolved before merge, or explicitly waived
  with a reason in the PR description
- A record of each review run (date, commit SHA, outcome, findings) is kept in
  `docs/security/reviews/` when the change is security-sensitive enough to
  merit one (a required review on a new adapter, or any review that produced a
  finding)
- Repo-wide audit reports from `security-auditor` are persisted verbatim as
  `docs/security/audit-*.md`

## Running it

From the repository root, on the branch with the pending changes:

```sh
/security-review
```

The review reads the pending diff on the current branch. It does not modify
files; findings are returned for the operator to act on.
