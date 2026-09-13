# yuurei v0.3 Security Audit — release candidate

## 1. Scope

|                      |                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commit**           | `07a61afbb1e577573dec5e9107c812c947c9461c` (release candidate: `main` + #55, #110, #111, #113)                                                                                                                                                          |
| **Re-verified at**   | `e4ad8c9` (the v0.1.0 release commit). The delta since `07a61af` is #116 (`src/run/pipeline.ts`) and #117 (`src/trace/writer.ts`) plus their tests; reviewed per `docs/security/review-policy.md` ("before any release tag") with no findings — see §6. |
| **Date**             | 2026-09-12                                                                                                                                                                                                                                              |
| **Method**           | Read-only repo-wide audit (design-doc invariants §9.1, §9.2, §9.3, §10.2, §12.1, §12.2 enumerated first; §12.1 non-goals applied as a false-positive filter) plus empirical runtime verification on isolated environments.                              |
| **Runtime versions** | Claude Code `2.1.269`, `codex-cli 0.154.0`, `node v26.8.2` (macOS).                                                                                                                                                                                     |
| **Test commands**    | `pnpm test` (175 tests, 35 files), `pnpm run check`, `pnpm run format`, `pnpm run build`, `pnpm run knip`, `pnpm run smoke:package` — all pass at this SHA.                                                                                             |
| **Supersedes**       | `docs/security/audit-v0.3.md` (targeted `8238315`, branch `issue-9-orphan-temp-cleanup`). Findings and verification items from that report are re-classified in §4.                                                                                     |

**Audited paths:** `src/run/*`, `src/runtime/**`, `src/isolation/*`, `src/artifact/collector.ts`,
`src/trace/*`, `src/profile/{loader,manifest}.ts`, `src/cell/resolver.ts`, `src/util/fs.ts`,
`src/cli/*`, `src/version.ts`, plus `test/integration/` and `src/**/*.test.ts`.

**Provenance.** Every invariant row and finding was verified against this repository's source at
the commit above. The §5 runtime behavior was measured empirically on isolated environments with no
real credential involved; claims about the Claude and Codex binaries depend on their installed
versions and degrade gracefully if they change.

## 2. Invariants verified

| #   | Invariant (source)                                                                                     | Status                                               | Settled by                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Never rename, move, or delete the user's real global config (§9.1, §2.3)                               | **Upheld**                                           | `configRootOf` points config roots at isolated dirs (`src/isolation/config-root.ts`); adapters write only under `rootDir`/`homeDir` (`codex/index.ts`, `claude-code/index.ts`); the Codex bridge is a one-way `copyFile`, never back. Covered by `test/integration/global-config-untouched.test.ts` (byte/mtime/inode identity).                                                                        |
| I2  | Never copy credentials into a profile (§9.2)                                                           | **Upheld**                                           | Credential flow is parent-env / real `~/.codex` → isolated dir only; `src/profile/loader.ts` is read-only over the profile source.                                                                                                                                                                                                                                                                      |
| I3  | Never record secrets in the trace; strip tokens/keys from logs (§9.2, §10.2)                           | **Upheld**                                           | Both streams redacted by exact value + shape patterns + terminal-prefix cut (`src/trace/redact.ts`, `pipeline.ts`). `resolved-profile.json` now records per-file digests/modes/bytes, never content (`src/profile/manifest.ts`) — **old Finding 3 closed**. `trace.json` carries only digests and counters.                                                                                             |
| I4  | A profile must not be able to redirect authentication to the operator's shared credential store (§9.2) | **Upheld (Codex); tested not-reproducible (Claude)** | Codex pins `cli_auth_credentials_store="file"` and `mcp_oauth_credentials_store="file"` on the CLI, outranking any materialized `config.toml`, and rejects a profile-supplied `auth.json`. Claude's `.credentials.json` is reserved and rejected before write; §5.1 records that a materialized `settings.json` `apiKeyHelper`/`forceLoginMethod` did **not** redirect auth or run commands on 2.1.269. |
| I5  | Temp cell removed after the run, and on `SIGINT`/`SIGTERM` (§9.1)                                      | **Upheld**                                           | `finally` and the signal handler join one memoized cleanup promise (`pipeline.ts`, `signals.ts`), so `process.exit()` cannot preempt in-flight scrub/dispose. Barrier regression test: `test/integration/signal-cleanup.test.ts`.                                                                                                                                                                       |
| I6  | `--keep` preserves config and logs, **never credentials** (§9.2)                                       | **Upheld**                                           | Credential paths are registered with the pipeline **at write time** (`registerCredentialPath`), so the scrub reaches material written during `prepare()` even when it never returns — **old Finding 1 closed**. An unregistered write plus a prepare() that never returned removes the whole root. Covered by `run-pipeline.test.ts` and `signal-during-prepare` fixture.                               |
| I7  | If isolation verification fails, the runtime is not started (§12.2)                                    | **Upheld**                                           | `createVerifiedIsolation` disposes before throwing on `!verified`; `context.keep` is assigned only after the gate. `test/integration/isolation-fail-closed.test.ts`.                                                                                                                                                                                                                                    |
| I8  | Path validation, isolation verification, credential bridging fail closed (§12.2)                       | **Upheld**                                           | No branch falls through to "allow". `assertNoReservedConfigPath` compares on the **resolved destination** (`join` + lowercased), closing the `./auth.json` alias class — **old V4 closed**. Bridge failure leaves the run unauthenticated, not permissive. Consistent with the existing design-doc §12.2 exception.                                                                                     |

## 3. Findings

No HIGH or confirmed MEDIUM findings at this commit.

**Hardening item (formerly the open tail of old Finding 2, MEDIUM → now structural checklist, not reproducible on the installed binary).**
`src/runtime/claude-code/args.ts` pins no credential-storage backend, and `settings.json` is
materialized unguarded (`claude-code/index.ts`) — the Codex adapter, by contrast, pins two stores on
the CLI. A profile's `settings.json` could in principle carry auth-steering keys. **Empirical result
(§5.1):** on Claude Code `2.1.269`, a planted `apiKeyHelper` (both array and string forms) and
`forceLoginMethod: "apiKey"` were **not** honored — the helper command never ran (marker file
absent) and the isolated run reported `Not logged in · Please run /login` in every variant, exactly
as without any `settings.json`. The harm the old audit described for `apiKeyHelper` ("additionally
executes a command") was not reproducible on the current binary. The structural gap (no backend
pin, no key-level reservation) is code-factual and worth closing as hardening — reserve/reject
auth-steering `settings.json` keys and pin the store on the CLI if the binary exposes a flag —
but it is not demonstrated exploitable on the supported runtime version.

## 4. Status of `audit-v0.3.md` findings

| Old finding / verification                                                                | Status at this commit                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding 1 — credential scrub bound to `prepare()` returning (MEDIUM)                      | **Fixed** by the write-time registration sink (#55): the scrub list is populated by the write, not the return. Regression-tested incl. a signal mid-`prepare()` under `--keep`.                                                                                                                                                                                                                                       |
| Finding 2(a) — no reserved-path guard on the Claude config dir (MEDIUM)                   | **Fixed**: `assertNoReservedConfigPath` now guards `.credentials.json` for Claude and `auth.json` for Codex, comparing on the resolved destination (tested for exact, `./`-prefixed, `sub/../`, upper-cased keys).                                                                                                                                                                                                    |
| Finding 2(b) — Claude `settings.json` auth overrides / no backend pin (MEDIUM confidence) | **Tested, not reproducible on 2.1.269** (see §5.1). Structural hardening item remains (see Findings).                                                                                                                                                                                                                                                                                                                 |
| Finding 3 — `resolved-profile.json` bypasses redaction (MEDIUM)                           | **Fixed** (#57): the durable record stores per-file digests/modes/bytes, never content. Regression-tested.                                                                                                                                                                                                                                                                                                            |
| V3 — orphan sweep missing uid check (LOW, env-dependent)                                  | **Fixed** (#58): sweep skips non-directories, symlinks, and directories owned by another uid (`tempdir.ts:71-81`).                                                                                                                                                                                                                                                                                                    |
| V4 — reserved-path guard trusts raw-key equality (hardening)                              | **Fixed**: comparison is on the resolved `join` output, lowercased.                                                                                                                                                                                                                                                                                                                                                   |
| V5 — `credentialFilePaths` snapshot misses unregistered runtime sidecars                  | **Open, narrowed further.** The sink registers only adapter-written files at `prepare()` time; a differently-named credential a runtime wrote during `execute()` would survive `--keep`. Non-interactive `codex exec` cannot complete an MCP OAuth flow (no browser/callback path), and §5.2 measured zero credential files under an isolated `CODEX_HOME`; deemed unreachable but still unproven. Keeping this open. |

## 5. Empirical verifications (issue #112)

Method for both runtimes: `env -i` (strip every variable), isolated `HOME` + runtime config dir,
fake values only, no real credential touched in or outside the isolation.

### 5.1 Claude Code 2.1.269 — authentication-related settings in an isolated home

Four configurations were planted under an isolated `CLAUDE_CONFIG_DIR` and each run with
`claude --print --output-format json 'say hi'`. Result discriminated by the `result`/`is_error`
fields only; no valid credential was ever involved.

| Planted at `$CLAUDE_CONFIG_DIR`                                                                                                                                          | Result                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`: `forceLoginMethod:"apiKey"` + `apiKeyHelper` (array command echoing `MARKER-EXECUTED` into a scratch file)                                              | `Not logged in · Please run /login`; the helper command **never ran** (marker file absent).                                           |
| `settings.json`: same, `apiKeyHelper` as a string command                                                                                                                | Helper did not run (test ended before output; the array-form result above is the decisive one).                                       |
| `.credentials.json` `{oauthAccount:{tokens:{...}}}`                                                                                                                      | `Not logged in · Please run /login`.                                                                                                  |
| `.credentials.json` flat `{accessToken, refreshToken}`                                                                                                                   | `Not logged in · Please run /login`.                                                                                                  |
| `credentials/default.json` (`created_by:"claude-code"`, `authentication:{type:"user_oauth",client_id:"anthropic-oauth"}`, `refresh_token`) + `ANTHROPIC_PROFILE=default` | `Not logged in · Please run /login`; the isolated dir gained only operational files (`.claude.json`, `backups/`, `projects/*.jsonl`). |

Conclusion: on the supported Claude version, no profile-supplied file or settings key under
`CLAUDE_CONFIG_DIR` was observed to redirect authentication, execute a command, or read a
credential. This does **not** weaken the reserved-path guard — it confirms the guard is at least as
conservative as the binary's current behavior (defense-in-depth rather than load-bearing against
2.1.269). Re-run the matrix after a Claude Code upgrade; it depends on the binary.

### 5.2 Codex `codex-cli 0.154.0` — isolated `CODEX_HOME` inventory under the adapter's flags

Ran `codex exec --json --skip-git-repo-check -c cli_auth_credentials_store="file"
-c mcp_oauth_credentials_store="file" 'say hi'` against an isolated `CODEX_HOME` seeded with a
`config.toml` defining an unreachable `http` MCP server (`http://127.0.0.1:9/sse`),
`OPENAI_API_KEY=sk-fake-…`. The run failed with 401 (the fake key was used; unauthenticated).

Files written under the isolated `CODEX_HOME`: `config.toml`, `.sandbox_migration`,
`installation_id`, `goals_1.sqlite`(+wal/shm), `logs_2.sqlite`, `memories_1.sqlite`, `queue_1.sqlite`,
`sessions/…/rollout-*.jsonl`, `skills/…`, `.tmp/plugins-clone-*/**`, `mcp-oauth-locks/file-store.lock`.

- **No credential-named file** (`auth*`, `credential*`, `oauth*`, `token*`, `*.key`) was written.
- The only OAuth-related file is `mcp-oauth-locks/file-store.lock` — a lock for the **file** credential
  store, confirming the adapter's `-c mcp_oauth_credentials_store="file"` pin moves OAuth state into
  the isolated `CODEX_HOME` instead of the operator's OS keyring (§9.2), exactly as designed.
- The MCP OAuth flow did not complete (server unreachable; non-interactive), so no token file could
  be written — consistent with old V5's inference, not yet empirically completed.

### 5.3 `--keep` and the trace completion marker

Verified by existing tests at this commit: a completed run under `--keep` keeps the isolated config
and logs, scrubs registered credential material, and writes `trace.json` last (completion marker), so
an interrupted persistence step leaves no run that `yuurei trace show` can consume
(`test/integration/trace-publication.test.ts`, `test/integration/signal-cleanup.test.ts`).

## 6. Final security verdict

At commit `07a61af`, no invariant is violated and no finding blocks the release. All three findings
from the prior audit are fixed or, for the Claude `settings.json` tail, tested-and-not-reproducible
on the installed binary. One structural hardening item is recorded (Claude adapter: reserve
auth-steering `settings.json` keys / pin the credential store) but is **not** demonstrated
exploitable on the supported Claude version. Old V5 (unregistered runtime sidecar under `--keep`)
remains open and out of demonstrable reach; treat it as a future work item, not a release blocker.

**Re-verified for the v0.1.0 tag (2026-09-13, commit `e4ad8c9`).** Two changes landed after the
audited SHA and were reviewed against the same invariants:

- **#116** — run-directory removal moved inside a `finally` around `disposeContext`
  (`src/run/pipeline.ts`). `scrubCredentials()` still runs first and is unaffected, so I6
  (`--keep` never preserves credentials) is unchanged; the new path only guarantees that a
  rejecting `dispose()` cannot strand a trace-less run directory.
- **#117** — `trace.json` is now published by write → `fsync` → `rename` from a same-directory
  temporary file (`src/trace/writer.ts`). The temporary file holds the **already-redacted**
  serialization (`redactSecrets` runs before the write), carries no content `trace.json` would not,
  and is removed on any failure. It cannot be mistaken for durable output: `collectArtifacts` takes
  an explicit path list (`['stdout.log','stderr.log']`) rather than enumerating the directory, and
  `readTrace` addresses `trace.json` exactly. A temporary file left by a hard crash sits inside the
  run directory and is removed with it (no `trace.json` ⇒ no completion marker ⇒ cleanup removes
  the directory).

No invariant is affected and no finding was raised. The verdict above stands for `e4ad8c9`.

## 7. Accepted risks (§12.1)

- **Exfiltration of a forwarded credential by profile hooks or `settings.json`**: declared trust
  boundary once bridging is on — profiles must be trusted as executable code. (Auth _substitution_
  via a reserved file is separately guarded.)
- **Malicious OS operations by the code under execution**, runtime vulnerabilities, network-based
  attacks, lack of complete process/filesystem isolation (§9.3, Level 0–1).
- **Cell-side symlink reads / rewrites**: `collectArtifacts` runs on the freshly created run dir and
  its truncation rewrite is `rename(temp, source)`, which replaces a planted symlink rather than
  writing through it — the prior accepted-risk analysis still holds.
- **A TSX check-then-read race** on profile/task files during materialization: explicitly out of
  scope (§12.1).
- **Bare, non-bridged tokens in agent stdout** that do not match the redaction shapes: best-effort
  per §10.2; the only source of such values is the operator's own task/profile.
