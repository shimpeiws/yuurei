# yuurei v1.0.0 Security Audit

## 1. Scope

|                |                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commit**     | `5a748874b3e4fcec7ec9045623cfd9cc9b450fee` (branch `main`, package version `0.5.0`, targeting v1.0.0 release)                                                                                                                                   |
| **Date**       | 2026-09-16                                                                                                                                                                                                                                      |
| **Method**     | Read-only repo-wide audit (design-doc invariants §9.1, §9.2, §9.3, §10.2, §12.1, §12.2 enumerated first; §12.1 non-goals applied as false-positive filter). Invariants verified against this commit's source only; no live runtime invocations. |
| **Supersedes** | `docs/security/audit-v0.3-release-candidate.md` (targeted `07a61af` / re-verified at `e4ad8c9`).                                                                                                                                                |

**Audited paths:** `src/run/{pipeline,signals,workspace,layout}.ts`, `src/runtime/{claude-code,codex,opencode}/**`, `src/isolation/{index,level0,level1,env,tempdir}.ts`, `src/artifact/collector.ts`, `src/trace/{redact,writer,schema}.ts`, `src/profile/{loader,manifest}.ts`, `src/util/fs.ts`, `src/runtime/reserved-paths.ts`, `src/config/schema.ts`, `docs/design/yuurei-design-v0.3.md`, `CLAUDE.md`.

**Delta since last audit.** The RC audit covered commits through `e4ad8c9` (v0.1.0 tag). Changes since that commit that are in scope include: the workspace-and-patch feature (`copyWorkspace`, `buildPatch`, `patch.diff` pipeline), the OpenCode runtime adapter (`src/runtime/opencode/**`), requested-cell identity freezing, and the Codex `CODEX_API_KEY` authentication fix. These are the focus of this review; the RC audit's conclusions on Claude Code and Codex carry forward unless contradicted by changed code.

---

## 2. Invariants verified

| #   | Invariant (design doc source)                                                                      | Status                                                                | Settled by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Never rename, move, or delete the user's real global config (`~/.claude`, `~/.codex`) (§9.1, §2.3) | **Upheld**                                                            | Adapters write only under `isolation.rootDir` or `homeDir` (confirmed for all three: Claude Code `index.ts:104`, Codex `index.ts:212`, OpenCode `index.ts:110`). Codex bridge is a one-way `copyFile`, never writes back. OpenCode bridge is the same pattern. The `copyWorkspace` destination is `layout.workspaceDir` (under `.yuurei/runs/`), sourced from the temp cell, never from `~/.claude` or `~/.codex`.                                                                                                                                                                                                                  |
| I2  | Never copy credentials into a profile; never record secrets in the trace (§9.2, §10.2)             | **Upheld**                                                            | Credential flow is always parent-env → isolated env or cell dir only; `profile/loader.ts` is read-only over the profile source and never sees bridged credential values. `resolved-profile.json` records only digests/modes/bytes (`manifest.ts:34-45`). `trace.json` passes through `redactSecrets` before write (`writer.ts:23`).                                                                                                                                                                                                                                                                                                 |
| I3  | Strip tokens, keys, auth headers from logs (§9.2, §10.2)                                           | **Upheld**                                                            | Both stdout and stderr pass through `redactFile(inputPath, outputPath, knownCredentialValues, maxArtifactBytes)` at `pipeline.ts:258-261`, applying exact-value and pattern-based redaction plus the terminal-prefix guard. `patch.diff` also passes through `redactFile` before publication (`pipeline.ts:288-294`).                                                                                                                                                                                                                                                                                                               |
| I4  | A profile must not redirect authentication to the operator's shared OS credential store (§9.2)     | **Upheld (Codex, OpenCode); structural hardening open (Claude Code)** | Codex pins `cli_auth_credentials_store="file"` and `mcp_oauth_credentials_store="file"` on the CLI. OpenCode's file-reference guard rejects any `{file:...}` reference escaping the cell (`config-guard.ts`), and rejects literal `apiKey` values. Claude Code reserves `.credentials.json` but does not pin a backend or filter `settings.json` keys — the hardening item from the RC audit is unchanged; empirically not exploitable on 2.1.269 per RC audit §5.1.                                                                                                                                                                |
| I5  | Temp cell removed after the run, and on SIGINT/SIGTERM (§9.1)                                      | **Upheld**                                                            | The finally block and the signal handler share one memoized `cleanup` promise (`pipeline.ts:208-212`), ensuring `process.exit()` in `signals.ts:88` cannot preempt an in-flight scrub/dispose. On isolation-verification failure the context is disposed inside `createVerifiedIsolation` before the throw (`isolation/index.ts:23`), and the run dir is removed in the catch block (`pipeline.ts:93`).                                                                                                                                                                                                                             |
| I6  | `--keep` preserves config and logs, **never credentials** (§9.2)                                   | **Upheld**                                                            | `scrubCredentials()` runs unconditionally at the start of `runCleanup()` (`pipeline.ts:178`), before `disposeContext()` and before the `context.keep` flag is consulted. The `registeredCredentialPaths` set is populated **at write time** (before `prepare()` returns) for both Codex (`codex/index.ts:222`) and OpenCode (`opencode/index.ts:132`). Claude Code writes no credential file, so nothing is registered. Under `--keep` with a `prepare()` that never returned and zero registered paths, the entire root is removed as a safety measure (`pipeline.ts:186-191`).                                                    |
| I7  | If isolation verification fails, the runtime is not started (§12.2)                                | **Upheld**                                                            | `createVerifiedIsolation` is called outside the inner try/finally block. If it throws, `runtime.prepare()` is never reached (`pipeline.ts:88-96`). The inner try/finally (which installs the signal handler and runs prepare/execute) is never entered. `installSignalCleanup` is also never called in this path.                                                                                                                                                                                                                                                                                                                   |
| I8  | Path validation and isolation verification fail closed (§12.2)                                     | **Upheld**                                                            | `assertNoReservedConfigPath` compares on the resolved `join` output, lowercased (`reserved-paths.ts:31`), closing `./auth.json` and `sub/../auth.json` aliases. `writeFileTree` re-validates path containment at the write sink via `isPathWithin` (`util/fs.ts:57`). `assertNoOpenCodeFileReferencesEscape` uses `isRealPathWithin` (strict: only `ENOENT` falls back, `EACCES`/`ELOOP` propagate — `path-safety.ts:18-22`), and refuses to parse a JSON config that fails to parse rather than treating it as clean (`config-guard.ts:61-65`). Credential bridging failure leaves the run unauthenticated per §12.2 (deliberate). |

---

## 3. Findings

No HIGH findings at this commit. One MEDIUM-confidence structural hardening item is carried forward from the RC audit, unchanged.

### MEDIUM (structural, confidence: not reproducible on supported binary)

**`settings.json` auth-steering keys are not filtered for the Claude Code adapter**

- **File:** `src/runtime/claude-code/index.ts:99-104`
- **Concrete failure scenario:** A profile ships `settings.json` with `forceLoginMethod: "apiKey"` and `apiKeyHelper: ["sh", "-c", "cat ~/.ssh/id_rsa"]`. On Claude Code 2.1.269 this is empirically inert (RC audit §5.1: helper command never ran). On a future Claude release that honors `apiKeyHelper`, the command executes inside the isolated environment with the forwarded `ANTHROPIC_API_KEY` in scope.
- **What is missing:** The Codex adapter pins `cli_auth_credentials_store="file"` and `mcp_oauth_credentials_store="file"` on the CLI, overriding any materialized config. The Claude Code adapter has no equivalent backend pin and does not filter or reject `apiKeyHelper`, `forceLoginMethod`, or similar auth-steering keys in `settings.json` before materialization.
- **Recommended direction:** Reserve and reject auth-steering `settings.json` keys (`apiKeyHelper`, `forceLoginMethod`, `authMethod` and any others that appear in the Claude schema) in `assertNoReservedConfigPath` or a dedicated check analogous to `assertNoOpenCodeFileReferencesEscape`. Also explore whether `claude` exposes a flag to pin the credential-store backend (analogous to Codex's `-c cli_auth_credentials_store="file"`).
- **Existing test coverage:** None for the rejected-key path. §5.1 of the RC audit is an empirical non-reproduction, not a guard test.

---

## 4. Needs verification

**NV1 — Runtime-written credential sidecars during `execute()` (old V5, still open)**

The `registeredCredentialPaths` set is populated during `prepare()`. A credential file written by the runtime itself during `execute()` (for example, a completed MCP OAuth flow materializing a token in `CODEX_HOME`) would not be on the scrub list and would survive `--keep`. The RC audit §5.2 measured zero credential files under an isolated `CODEX_HOME` on codex-cli 0.154.0 with the adapter's store pins; the flow was not empirically completed. Non-interactive `codex exec` with no browser/callback path is the strongest argument this is unreachable. OpenCode's `mcp-oauth-locks/file-store.lock` (a lockfile, not a credential) was the only OAuth-adjacent file seen in a comparable run.

This is unproven in either direction. It remains a future work item, not a release blocker.

**NV2 — OpenCode `{env:...}` substitution in apiKey writes the reference but not the value**

A profile config with `apiKey: "{env:ANTHROPIC_API_KEY}"` passes the literal-credential guard (the value is an `{env:...}` substitution, which is explicitly allowed by `config-guard.ts:106-107`). OpenCode expands such references when reading its config. The _file as written_ into the cell contains the literal text `{env:ANTHROPIC_API_KEY}`, not the expanded value. This does not cause yuurei to write a credential to disk. However, if OpenCode materializes the expanded value into its database (`goals_1.sqlite`, `sessions/`, etc.) during the run, those files are in the cell and survive `--keep`. Whether OpenCode persists the resolved API key into its SQLite databases has not been empirically verified for this substitution path.

**NV3 — OpenCode `diagnostics` fixed-string guarantee for unreadable stdout**

At `opencode/index.ts:269`, the `catch` for an unreadable stdout produces a fixed string (`'opencode: stdout unreadable — usage unobserved'`), deliberately omitting `err.message` because it can carry a filesystem path. The comment is correct. The surrounding `readFile` path produces genuine fixed-string diagnostics. The concern is whether a future OpenCode event type with a user-controlled body could reach diagnostics through the normalization logic. At this commit, only `error` event type triggers `sawError = true` (a flag, not a diagnostic with the error body), and `step_finish` metrics produce only structured number-parsing diagnostic lines. The guard holds at this commit; re-check after the normalization logic expands.

---

## 5. Surfaces reviewed and found clean (summaries)

**A. Credential lifecycle — all exit paths covered.** Normal completion: `finally` → `cleanup()` → `scrubCredentials()` → `disposeContext()`. Signal: `signals.ts` handler awaits the same memoized `cleanup` promise, so `process.exit()` fires only after scrub and dispose have settled. Isolation-verification failure: context disposed inside `createVerifiedIsolation`, run dir removed in catch, inner try/finally never entered, no credentials written at this point. `execCapture` rejection and exceptions during `prepare()`: `finally` runs `cleanup()`; for the prepare-throw case, `registeredCredentialPaths` already holds the path because registration happens before the write (Codex `index.ts:222`, OpenCode `index.ts:132`). `--keep`: `scrubCredentials()` runs unconditionally and before `disposeContext()`.

**B. Redaction coverage.** Stdout and stderr are both passed through `redactFile` (`pipeline.ts:258-261`). `patch.diff` is passed through `redactFile` before `rename` publishes it (`pipeline.ts:288-294`). `trace.json` goes through `redactSecrets` in `writer.ts:23`; the trace schema's closed structure (digests, counters, version strings, no raw env vars) means the lack of `redactKnownValues` here is adequate. `resolved-profile.json` records digests, modes, and bytes (never content) via `manifest.ts`; the `profileYaml` field is schema-constrained to `runtime: string, description?: string` and carries no credential field. The byte-cap / redaction ordering is: buffer up to `maxBytes` → `redactKnownValues` → `redactSecrets` → `redactTerminalKnownPrefix` → cap output at `maxBytes` again; a `[REDACTED]` replacement is 10 bytes vs. the 8-byte minimum secret length, so size can increase by at most 2 bytes per match, which the secondary cap at `redact.ts:87-88` absorbs.

**C. Profile materialization.** The reserved-path check at `assertNoReservedConfigPath` compares on `join(destDir, key).toLowerCase()`, handling `./auth.json` and `sub/../auth.json` aliases. The write sink `writeFileTree` re-validates path containment independently of the caller-side check (`util/fs.ts:57`). The OpenCode file-reference guard (`config-guard.ts`) runs before `writeFileTree`, uses `isRealPathWithin` (strict: `EACCES`/`ELOOP` propagate), inspects **decoded** JSON values (JSON escapes like `\u007e` cannot hide a reference), rejects empty `{file:}` references, rejects `~user` forms, refuses to parse a JSON config that fails to parse (fail closed), and rejects literal `apiKey`/`api_key` values at any depth. The guard runs pre-write, before OpenCode starts.

**D. Outward reads and writes during artifact collection.** `collectArtifacts` is called on `layout.runDir` (`pipeline.ts:321`) with an explicit path list (`['stdout.log', 'stderr.log', 'patch.diff']`). These files are written by yuurei's own redaction pipeline, not by the agent. The agent runs in `isolation.workspaceDir` inside the temp cell; `.yuurei/runs/<id>/` is a separate directory that the agent never writes to. On truncation, `rename(tempPath, sourcePath)` replaces the path atomically, which would replace a hypothetical symlink rather than write through it.

**E. Fail-closed behavior.** `createVerifiedIsolation` throws on `!report.verified` after disposing the context (`isolation/index.ts:23-28`). The call site is outside the inner try/finally block; a throw there removes the run dir and exits `runPipeline` without entering the inner try block or calling `runtime.prepare()`. For exceptions thrown inside the inner try, the finally block calls `cleanup()` with error-swallowing so a cleanup failure does not mask the primary error. No branch falls through to a permissive state.

**F. Environment allowlist.** `ALLOWED_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']` (`env.ts:6`). `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `SSL_CERT_FILE`, `HTTP_PROXY`, and all other behavior-altering variables are excluded. Credential env vars (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, etc.) are not in the allowlist; they are forwarded only by the adapter's explicit bridge functions. For OpenCode under Level 0 (real HOME), all five XDG dirs and `TMPDIR` are explicitly redirected into the cell by `openCodeEnv(configRoot)` (`paths.ts:15-25`), preventing OpenCode from reading the operator's real global config or writing to `/tmp/opencode`. Level 0 and Level 1 both start from the same `buildRestrictedEnv` call; Level 0 carries the real HOME deliberately and its verification check confirms this (`level0.ts:47-50`).

**G. Orphan sweep ownership.** `findOrphanTempDirs` (`tempdir.ts:53-85`) checks `entry.isDirectory()` (excluding symlinks and files), then re-checks `lstat(path).isDirectory()` to guard against a swap between `readdir` and `lstat`, then checks `info.uid !== uid` (`tempdir.ts:79`) to skip directories owned by another user. `uid` is `process.getuid?.()`, undefined on platforms with no POSIX uid (Windows), where the check is skipped — acceptable given the macOS/Linux target. The 24-hour age threshold ensures in-progress runs are never touched. V3 from the original audit is confirmed fixed.

---

## 6. Status of prior findings

| Finding / item                                                             | Status at this commit                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Finding 1 (RC) — scrub bound to `prepare()` returning                      | **Fixed** (pre-registration sink in place; confirmed for Codex `codex/index.ts:222`, OpenCode `opencode/index.ts:132`). |
| Finding 2(a) (RC) — no reserved-path guard on Claude config dir            | **Fixed** (`.credentials.json` reserved, comparison on resolved `join` output).                                         |
| Finding 2(b) (RC) — Claude `settings.json` auth overrides / no backend pin | **Open hardening item** (see §3). Unchanged from RC audit.                                                              |
| Finding 3 (RC) — `resolved-profile.json` bypasses redaction                | **Fixed** (digests/modes/bytes only; confirmed by `manifest.ts`).                                                       |
| V3 (RC) — orphan sweep missing uid check                                   | **Fixed** (`tempdir.ts:79`).                                                                                            |
| V4 (RC) — reserved-path guard trusts raw-key equality                      | **Fixed** (resolved `join` + lowercased).                                                                               |
| V5 (RC) — unregistered runtime sidecars during `execute()`                 | **Open** (see NV1). No change.                                                                                          |

---

## 7. OpenCode adapter (new since last audit)

The OpenCode adapter (`src/runtime/opencode/**`, shipped as part of v0.4.0/v0.5.0) is the major addition since `e4ad8c9`. The audit of its security-relevant surfaces:

- **Credential bridging** mirrors the Codex pattern and passes the same checks as I6 above.
- **File-reference guard** (`config-guard.ts`) implements §20.5 correctly: JSON/JSONC decoded-value inspection, strict-`realpath` containment check, literal `apiKey`/`api_key` rejection, `~user` refusal, empty-reference refusal, fail-closed on parse failure.
- **XDG redirection** (`paths.ts`) redirects all five OpenCode roots plus `TMPDIR` into the cell, per the contract in §20.3.
- **Disable flags** (`opencode/index.ts:106-108`): `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_EXTERNAL_SKILLS` — all set before `writeFileTree`.
- **Output normalization** produces only fixed-string diagnostics; error event bodies are never persisted (`opencode/index.ts:196-200`).
- **Auth.json bridge** (`auth.ts:94-123`) uses `isRealPathWithin` (strict) as a symlink guard on the source, registers the destination before copying, and mirrors Codex's double-fault behavior.

No findings raised for the OpenCode adapter.

---

## 8. Accepted risks (§12.1)

- **Exfiltration of a forwarded credential by profile hooks or materialized config**: declared trust boundary once bridging is on — profiles must be trusted as executable code (CLAUDE.md). Auth _substitution_ via a reserved file is separately guarded. This covers both Claude Code `settings.json` (where the empirical guard matters) and OpenCode `{env:...}` substitutions.
- **Malicious OS operations by the code under execution**, runtime vulnerabilities, network-based attacks, and absence of complete process/filesystem isolation (§9.3, Level 0–1). The agent can access any resource its OS permissions allow; this is the documented isolation model.
- **Cell-side symlink manipulation**: collecting artifacts from the run dir is not reachable by the agent; the `rename` truncation path replaces rather than writes through a potential symlink. The RC audit's analysis still holds.
- **TOCTOU race on profile/task materialization**: `isPathWithin` is check-then-read; a filesystem actor racing the check is explicitly out of scope (§12.1).
- **OpenCode admin-controlled configuration** (`/Library/Application Support/opencode/`, remote `.well-known/opencode`): read outside the cell, cannot be redirected by the adapter, treated as trusted (§20.9).
- **Bare, non-bridged tokens in agent stdout** not matching redaction shapes: best-effort per §10.2.

---

## 9. Security verdict

At commit `5a748874`, no invariant is violated and no finding blocks the v1.0.0 release. The OpenCode adapter is the principal new surface and was found correctly implemented against its contract (§20). All confirmed fixes from the RC audit remain in place. Two items remain open (NV1 runtime sidecar under `--keep`, NV2 OpenCode env-substitution DB persistence) as future verification work, not release blockers. The structural hardening item for the Claude Code adapter (§3: `settings.json` key filter and backend pin) remains recommended hardening; it is not demonstrated exploitable on the supported Claude version.

---

## Disposition (session note)

Recorded by the session that ran the audit, per `docs/security/review-policy.md`.

- **No HIGH findings; no invariant is violated; the v1.0.0 release candidate is not blocked.**
- **The one MEDIUM item — Claude Code `settings.json` auth-steering keys are not filtered — is accepted as a risk, not fixed.** It is not demonstrated exploitable on the supported Claude Code version, and the vector it describes (a profile `settings.json` causing a command to run with the forwarded key in scope) is the profile trust boundary `CLAUDE.md` already states: once bridging is on, profile hooks and settings are trusted the same way executable code is. The Claude Code credential path is env-only, so there is no OS credential-store backend to force, which is why it has no backend pin. A reserved-key filter is worth adding as defence in depth in a future release; it is tracked here rather than treated as a 1.0 prerequisite.
- **NV1, NV2 and NV3 stay \"needs verification\"**; none is a release blocker.
