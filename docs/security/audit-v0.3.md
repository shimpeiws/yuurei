# yuurei v0.3 Security Audit

## 1. Scope

|            |                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commit** | `8238315f107da5c8ea37caa7b75075e578f558e1`                                                                                                                                    |
| **Branch** | `issue-9-orphan-temp-cleanup`                                                                                                                                                 |
| **Date**   | 2026-09-10                                                                                                                                                                    |
| **Method** | Read-only. Design-doc invariants (§9.1, §9.2, §9.3, §10.2, §12.1, §12.2) enumerated before any implementation was opened; §12.1 non-goals applied as a false-positive filter. |

**Audited paths:** `src/run/*`, `src/runtime/**`, `src/isolation/*`, `src/artifact/collector.ts`,
`src/trace/*`, `src/profile/loader.ts`, `src/cell/resolver.ts`, `src/util/fs.ts`, `src/cli/*`,
plus `test/integration/`.

**Provenance.** Findings 1, 2(a) and 3 and every invariant row were verified against this
repository's source. Finding 2(b) rests on string extraction from the locally installed Claude Code
binary (`~/.local/share/claude/versions/2.1.267`, no execution) — an external artifact whose
behavior may change between versions. That dependency is marked inline, and Finding 2 is written to
degrade gracefully if it does not hold.

## 2. Invariants verified

| #   | Invariant (source)                                                                                        | Status                                                                     | Settled by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Never rename, move, or delete the user's real global config (§9.1, §2.3)                                  | **Upheld**                                                                 | Nothing outside the temp root is written or removed. `configRootOf` points config roots at `homeDir`/`rootDir` (`src/isolation/config-root.ts:9`); `removeTempDir` only targets `createTempDir` output (`src/isolation/tempdir.ts:33-39`). The Codex bridge is a `copyFile` _from_ the real home, never back (`src/runtime/codex/index.ts:149`) — deliberately a copy, not a symlink, so a mid-run token refresh cannot write through. Covered by `test/integration/global-config-untouched.test.ts`.                                                                                  |
| I2  | Never copy credentials into a profile (§9.2)                                                              | **Upheld**                                                                 | Credential flow is one-directional (parent env / real `~/.codex` → isolated dir). No path writes into a profile `sourceDir`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| I3  | Never record secrets in the trace; strip tokens/keys from logs (§9.2, §10.2)                              | **Upheld for logs and `trace.json`; VIOLATED for `resolved-profile.json`** | Logs: exact-value redaction of adapter-reported credentials then shape-based patterns, over both streams (`src/run/pipeline.ts:177-180`). `trace.json`: `redactSecrets` at `src/trace/writer.ts:9`; the schema carries only digests and counters. `resolved-profile.json` bypasses redaction entirely — **Finding 3**.                                                                                                                                                                                                                                                                 |
| I4  | A profile must not be able to redirect authentication to the operator's shared OS credential store (§9.2) | **Upheld for Codex; NOT enforced for Claude Code**                         | Codex passes `-c cli_auth_credentials_store="file"` and `-c mcp_oauth_credentials_store="file"` on the CLI (`src/runtime/codex/args.ts:25-28`), outranking any materialized `config.toml`, and rejects a profile-supplied `auth.json` outright (`src/runtime/codex/index.ts:37-47`, called at `:190`). `buildClaudeCodeArgs` pins nothing (`src/runtime/claude-code/args.ts:8-15`) and the adapter has no reserved-path check — **Finding 2**.                                                                                                                                         |
| I5  | Temp cell removed after the run, and as far as possible on `SIGINT`/`SIGTERM` (§9.1)                      | **Upheld**                                                                 | `finally` → `cleanup()` (`src/run/pipeline.ts:192-203`) and the signal handler (`src/run/signals.ts:54-77`) share one idempotent `cleanup` guarded by `disposed`. The handler uninstalls both handlers first, so a second signal takes the default disposition; the `finally` block awaits the same promise, so `process.exit()` cannot preempt an in-flight dispose. Covered by `test/integration/signal-cleanup.test.ts`. A signal before `installSignalCleanup` leaves a temp dir for the orphan sweep; no credential material exists that early.                                   |
| I6  | `--keep` preserves config and logs, **never credentials** (§9.2)                                          | **VIOLATED on the prepare-time exit path**                                 | Happy path correct and tested (`src/run/pipeline.ts:67-89`; `test/integration/run-pipeline.test.ts:57`). Credential material written _during_ `prepare()` is unreachable by the scrub — **Finding 1**.                                                                                                                                                                                                                                                                                                                                                                                 |
| I7  | If isolation verification fails, the runtime is not started (§12.2)                                       | **Upheld**                                                                 | `createVerifiedIsolation` is the only gate and disposes before throwing on `!report.verified` (`src/isolation/index.ts:22-28`), before `prepare`/`execute` exist. `context.keep` is assigned only after the gate (`src/run/pipeline.ts:60`), so verification failure removes the temp dir even under `--keep`. Covered by `test/integration/isolation-fail-closed.test.ts`.                                                                                                                                                                                                            |
| I8  | Path validation, isolation verification and credential bridging fail closed (§12.2)                       | **Upheld**                                                                 | No branch falls through to "allow". `writeFileTree` re-validates containment at the write sink (`src/util/fs.ts:57-62`); `loadProfile` calls `realpath` _before_ `isPathWithin`, so a dangling symlink cannot pass the guard (`src/profile/loader.ts:69-81`); `isPathWithin` resolves symlinks on both sides and appends only the non-existent tail (`src/util/fs.ts:14-31`). Bridge failure returns `{wrote:false}` (`src/runtime/codex/index.ts:141-163`) — degrade-to-unauthenticated, which §12.2 specifies, not degrade-to-allow. The one deliberate abort (`:157`) fails closed. |

## 3. Findings

### Finding 1 — Credential scrub is bound to `prepare()` returning (MEDIUM)

`src/run/pipeline.ts:74` (guard), `:108` (assignment); `src/isolation/level1.ts:60` (`--keep`
no-op); `src/runtime/codex/index.ts:149-165` (the write).

`scrubCredentials` opens with `if (!prepared || scrubbed) return;`, but `prepared` — which carries
`credentialFilePaths` — is assigned only when `prepare()` _returns_. The scrub list therefore comes
into existence only after every credential file is already on disk, so any exit between the write
and that return silently no-ops. The only other remover is `dispose()`, which is a no-op under
`--keep`. This contradicts the comment at `:98-100` ("runs regardless of which branch above threw").

**Failure scenario.** `yuurei run <name> --keep --bridge-codex-auth-file`, with
`~/.codex/auth.json` holding an interactive ChatGPT login. `copyFile` + `chmod 0600` write the token
file to `<tmp>/yuurei-XXXX/home/.codex/auth.json` (`:149-150`). Execution continues into
`extractCodexAuthSecrets` and then `this.detect()` (`:203`), which spawns `codex --version` and
awaits it. Ctrl-C anywhere in that window → the handler installed at `pipeline.ts:105` (before
`prepare()`) fires → the scrub returns early on `!prepared` → `dispose()` returns early on `keep` →
`exit(130)`. A live OAuth **access and refresh** token pair is left in `/tmp`, with no `onWarning`
naming it, until a `yuurei clean` past the 24h threshold.

Note this is reachable by asynchronous signal delivery alone — it does not require any statement in
`prepare()` to throw. (Every statement between the `auth.json` write and the return is in fact
throw-free: `detectViaVersionFlag` and `extractCodexAuthSecrets` both swallow their errors and
`buildCodexArgs` cannot throw.) The documented double fault at `:151-161` reaches the same state via
a throw.

**Scope.** Only the opt-in Codex auth-file bridge writes credentials to disk today; Claude Code is
env-only (`credentialFilePaths: []`). The binding is structural, so any future adapter that writes
during `prepare()` inherits it.

**Direction.** Let the adapter register each path with the pipeline at the moment it writes it (a
callback or mutable sink passed into `prepare()`), so the scrub list is populated by the _write_
rather than by the return. Additionally surface the double-fault residual path through `onWarning`.

**Test coverage.** Not covered. `test/integration/run-pipeline.test.ts:57` asserts this invariant
only where `prepare()` returns normally; `test/integration/profile-materialization.test.ts:177`
calls `prepare()` directly rather than through `runPipeline`, so it never observes the residue.

### Finding 2 — No reserved-path guard on the Claude config dir (MEDIUM — confirmed empirically)

`src/runtime/claude-code/index.ts:66-69`; contrast `src/runtime/codex/index.ts:37-47`, `:190`.

**(a) Proven by this repository.** `prepare()` writes the profile's entire `configFiles` tree into
`configDir` and sets `CLAUDE_CONFIG_DIR=configDir`. `writeFileTree` enforces only containment
(`src/util/fs.ts:57-62`), so a key such as `.credentials.json` is written without objection. Codex
rejects its analogous reserved key before any write — and does so _even when its bridge is
disabled_, precisely because (in its own words, `src/runtime/codex/index.ts:27-33`) otherwise "the
run would silently authenticate with whatever the profile supplied instead of the operator's real
credential." Claude has no equivalent check. Separately, `buildClaudeCodeArgs`
(`src/runtime/claude-code/args.ts:8-15`) pins no credential-storage backend, where `buildCodexArgs`
pins two — so the §9.2 clause requiring the adapter's CLI invocation to force the backend at the
highest-precedence layer is unimplemented for Claude Code.

**(b) Confirmed empirically** (Claude Code 2.1.267, macOS; see V1/V2 in §4 for the method). Claude
Code reads, parses and _uses_ `$CLAUDE_CONFIG_DIR/.credentials.json`. Planting a well-formed but fake
OAuth token there changes the failure from `Not logged in · Please run /login` to
`Failed to authenticate. API Error: 401 OAuth access token is invalid.` — the token was read from the
profile-writable directory and sent to the API. A malformed file is ignored silently and falls back
to `Not logged in`.

**The precondition is the default state, not a corner case.** On a machine authenticated by
subscription login, there is no `~/.claude/.credentials.json`; the credential lives in the macOS
Keychain, and `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are unset. `detect()` therefore reports
`authUsable: false` (`src/runtime/claude-code/index.ts:60`) and bridging forwards nothing.
Independently confirmed (V2) that the spawned binary does **not** fall back to the Keychain once
`HOME` and `CLAUDE_CONFIG_DIR` are redirected. So the isolated run has _no_ credential of its own —
which means a profile-supplied `.credentials.json` is not competing with anything. It is used
unconditionally.

**Failure scenario.** A shared template profile carrying `config/.credentials.json` makes the run
authenticate as the profile author. The operator's task text and the model's responses land in an
account the operator does not control, while `trace.json` records `isolation.verified: true` and
`authUsable: false`. A profile-supplied `settings.json` setting `apiKeyHelper` is the same class of
problem and additionally executes a command.

Note this is not covered by §9.2's exfiltration trust boundary. §9.2 separately and explicitly
requires that a profile must not be able to redirect authentication — which is exactly what the
Codex guard exists to prevent.

**Direction.** Give the Claude adapter an `assertNoReservedAuthFileKey` analogue covering
`.credentials.json` (and consider `settings.json`'s `apiKeyHelper`/`forceLoginMethod` keys), and pin
the credential-storage backend on the CLI the way `buildCodexArgs` does.

**Test coverage.** Not covered.

### Finding 3 — `resolved-profile.json` bypasses redaction entirely (MEDIUM)

`src/run/pipeline.ts:145-149`; `src/profile/types.ts:14`; contrast `src/trace/writer.ts:9`.

`writeTrace` runs `redactSecrets` over `trace.json`, but `resolved-profile.json` is written with a
bare `JSON.stringify(cell.resolvedProfile, null, 2)` and no redaction of any kind.
`ResolvedProfileRef.content.configFiles` holds the **full byte content of every file** under the
profile's `config/`.

**Failure scenario.** A profile whose `config/` contains an MCP server definition with an API key —
an ordinary shape for both Claude Code and Codex profiles — is run once. The key is written verbatim
and durably to `.yuurei/runs/<run-id>/resolved-profile.json`, a directory that outlives the cell by
design. This contradicts §10.2 ("API keys", "auth tokens" are not recorded).

Detection is worse than for a plain leak: `Buffer` serializes as `{"type":"Buffer","data":[104,...]}`,
so the secret is stored as a byte array. `redactSecrets`' shape-based patterns could not match it
_even if they were applied_, and neither would an operator's later `grep` for the key.

**Direction.** Decide what `resolved-profile.json` is actually for. If reproducibility only needs
identity, persist the per-file digests already computed for `cellDigest` instead of the bytes. If
the bytes must be retained, decode them to text and run them through `redactFile`'s pipeline
(including `credentialValuesToRedact`) before writing — and note that redaction must happen before
`Buffer` serialization, not after.

**Test coverage.** Not covered.

## 4. Verification items (V1–V2 resolved, V3–V4 open, V5 investigated — open pending empirical confirmation)

V1 and V2 were open at the time of the audit and have since been **resolved by experiment**
(Claude Code 2.1.267, macOS 25.5, 2026-09-10). They are retained here with their results, because the
method is reusable when the runtime is upgraded. V3–V5 remain open and were reached by reading only.

- **V1 — RESOLVED, confirms Finding 2. Claude Code does read `$CLAUDE_CONFIG_DIR/.credentials.json`.**
  Method — three runs under an isolated `HOME` and config dir, distinguished by the error text alone,
  so no valid credential is ever needed:

  ```sh
  run() { env -i PATH="$PATH" TERM="$TERM" HOME=/tmp/ycheck \
      CLAUDE_CONFIG_DIR=/tmp/ycheck/.claude \
      claude --print --output-format json 'say ok'; }
  ```

  | Planted at `$CLAUDE_CONFIG_DIR/.credentials.json` | `result`                                                                |
  | ------------------------------------------------- | ----------------------------------------------------------------------- |
  | _(nothing)_                                       | `Not logged in · Please run /login`                                     |
  | `THIS-IS-NOT-JSON`                                | `Not logged in · Please run /login` (malformed → ignored silently)      |
  | well-formed JSON, fake OAuth token                | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` |

  The third row is the proof: the token was read from the profile-writable directory, parsed, and
  sent to the API. Finding 2 is therefore MEDIUM, not LOW.

- **V2 — RESOLVED in yuurei's favour. No Keychain fallback; Level 1 isolation holds.** With
  `env -i` stripping every variable (so a leaked env credential cannot explain the outcome) and
  `HOME`/`CLAUDE_CONFIG_DIR` redirected, `claude --print` fails with `Not logged in · Please run
/login` while the Keychain item (`svce="ClaudeCode-credentials"`, `acct=<the local user>`) remains present
  and readable by the same uid. An unisolated positive control run in the same session succeeded
  (real token usage, `stop_reason: end_turn`), so the failure is authentication and not network,
  quota, or arguments. The isolated run also wrote `.claude.json` into the isolated dir, confirming
  the redirect was honoured.

  This is a meaningful positive result: the §9.3 Level 1 claim holds for the Claude credential path,
  and `detect()`'s `authUsable: false` is accurate rather than a false report. Re-run the method
  above after a Claude Code upgrade, since it depends on the binary's behaviour rather than on
  yuurei's code.

- **V3 — Orphan-sweep ownership (LOW, environment-dependent).** `findOrphanTempDirs`
  (`src/isolation/tempdir.ts:66-79`) deletes any `yuurei-*` directory older than 24h with no uid
  check. Harmless on macOS's per-user `/var/folders`; on a Linux host with a shared `/tmp`, user A's
  `yuurei clean` removes user B's idle directory. Deletion only — the sweep is symlink-aware via
  `d_type` + `lstat`, so it cannot be redirected. `stat().uid === getuid()` closes it. A question,
  not a finding, until the intended deployment surface is settled.
- **V4 — Reserved-path guard trusts a caller-side invariant (hardening, not exploitable today).**
  `assertNoReservedAuthFileKey` (`src/runtime/codex/index.ts:40`) compares
  `key.toLowerCase() === 'auth.json'`. The ordering is the point: the guard runs on the **raw key,
  before** `writeFileTree`'s `join()` normalizes it, so a key like `./auth.json` would slip the
  exact-match check while `join()` still lands the file on the reserved path. Confirmed not reachable
  today — `loadProfile` produces every key via `relative(rootDir, fullPath)`
  (`src/profile/loader.ts:92` and `:107`), whose output is normalized, and `auth.json` is ASCII so
  Unicode NFD is a non-issue. The note stands because the guard duplicates a trust assumption its
  sibling at the same boundary explicitly refuses to make — `writeFileTree` re-validates "rather than
  trusting a caller-side invariant it cannot enforce" (`src/util/fs.ts:44-47`). Worth a unit test
  pinning `./auth.json`, and normalizing the key before comparing.
- **V5 — `credentialFilePaths` is a snapshot taken at `prepare()` time.** An in-place `auth.json`
  refresh during the run is still scrubbed, since the path is unchanged; a _differently-named_
  sidecar written by the runtime after `prepare()` is not on the list, so it is never scrubbed and
  `--keep` preserves it.

  **Investigated 2026-09-10 against codex-cli 0.153.4** (issue #60). Evidentiary status: items
  marked "(measured)" rest on direct observation; the final conclusion is marked "(inference)" and
  has not been confirmed by running an OAuth MCP flow to completion.

  _(measured)_ A real `codex exec` run against an isolated `CODEX_HOME` seeded only with the
  bridged `auth.json`, using the same `-c` flags `buildCodexArgs` passes, wrote roughly 200 files.
  No credential-named file appeared beyond `auth.json`. The notable additions are operational state:
  `sessions/2026/…/rollout-*.jsonl` (full session transcript), `state_5.sqlite`,
  `thread_history_1.sqlite`, `memories_1.sqlite`, `goals_1.sqlite`, `queue_1.sqlite`,
  `logs_2.sqlite`, `plugins/cache/openai-curated-remote/**` (plugin bundles), `models_cache.json`,
  `installation_id`, `.sandbox_migration`. These survive `--keep` but are not credential material.

  _(measured)_ `mcp_oauth_credentials_store` accepts exactly three values: `auto`, `file`,
  `keyring`. `ephemeral` is rejected. The binary's embedded default is `auto`, which prefers the
  keyring when one is available. The current `buildCodexArgs` pin to `file` is therefore
  load-bearing — without it, an OAuth-using MCP server would reach the operator's real OS keychain
  (§9.2 violation). The pin is confirmed correct and should stay.

  _(inference, not measured)_ For a credential file to exist, Codex must complete an MCP OAuth
  flow. That flow requires a local callback server (`mcp_oauth_callback_port`) and a browser
  redirect. `yuurei` runs `codex exec --json`, non-interactive, against a freshly created
  `CODEX_HOME` holding no prior tokens. Under this execution model the OAuth flow has no path to
  completion, so the credential file has no path to being written.

  **Residual exposure after #55.** Finding 1 (#55) changed the calculus: the isolation root is
  now removed on every exit path except a completed run under `--keep`. The remaining exposure is:
  `--keep` **and** a run that reached completion **and** a profile configuring an
  OAuth-authenticating MCP server. Narrower than the original framing, but the inference above is
  what makes even this path appear unreachable.

  **Disposition.** Issue #60 remains open. The inference is plausible and the original concern is
  substantially narrowed, but it has not been settled empirically. Closing empirically requires
  standing up an OAuth MCP server, observing what file Codex writes, and adding that path to the
  reserved set alongside `auth.json`. If that work is done, update this entry and close #60.

## 5. Accepted risks (§12.1)

Considered and excluded by the declared non-goals; recorded so a future reviewer does not re-raise
them as findings.

- **Exfiltration of a bridged credential by profile hooks or `settings.json`.** §9.2 states this
  outright: once bridging is on, anything a profile can run reaches the credential, and profiles must
  be trusted as executable code. This is the declared trust boundary, not a defect. (Auth
  _substitution_ — Finding 2 — is a separate matter, because §9.2 separately promises a profile
  cannot redirect authentication.)
- **Symlink planted at the cell's own `stdout.log`.** This one is genuinely reachable and is worth
  stating precisely, because the obvious suspect is the wrong one. The _durable_ side is safe:
  `collectArtifacts` runs on `layout.runDir` (`src/run/pipeline.ts:182`) — the freshly created
  `.yuurei/runs/<id>/` directory (`mkdir(..., {recursive: false})`) — never on the cell, and its
  `rename(tempPath, sourcePath)` (`src/artifact/collector.ts:84`) replaces a symlink rather than
  writing through it. The exposure is one step earlier: `redactLog(result.stdoutPath, ...)`
  (`src/run/pipeline.ts:178`) reads `join(rootDir, 'stdout.log')`, **inside the cell**, so
  `createReadStream` (`src/trace/redact.ts:76`) and `readFile` (`src/runtime/claude-code/index.ts:110`)
  follow an agent-controlled path. An agent that replaces its own `stdout.log` with a link to, say,
  `~/.ssh/id_rsa` gets the target's content copied into the durable run directory — and
  `redactSecrets`' patterns do not match a PEM block. Accepted because the agent runs as the same uid
  and could simply print that file to stdout for the same result: no privilege amplification, and
  §12.1 places malicious OS operations by the code under execution out of scope. Recorded because the
  durable artifact then holds content the operator did not expect, which is worth knowing when
  reading a trace.
- **Symlink-following write in `redactFile`** (`src/trace/redact.ts:88`). Reaching it requires
  planting a link inside a freshly created, unpredictably named run directory, and yields no
  privilege the agent does not already have.
- **Level 0 leaves the real `HOME` exposed** — by design, and asserted as such
  (`src/isolation/level0.ts:42-45`). Level 0 swaps only the config root; §9.3 is explicit that
  configuration-level isolation is not a security boundary.
- **TOCTOU between `isPathWithin` and the subsequent read/write.** §12.1 names this explicitly:
  the check is check-then-read, not atomic, and a filesystem actor racing it is out of scope.
- **Malicious OS operations by the agent under execution**, runtime vulnerabilities, network
  attacks, and the absence of true process/filesystem isolation. §9.3 states isolation is
  configuration-level (Level 0–1), not a security boundary against malicious code.
- **Absolute paths in error messages.** The design makes no secrecy claim about paths, and operators
  need them to act on a warning naming a residual credential file.

## 6. Summary

No HIGH findings. The codebase is substantially hardened against the generic classes — path
containment is re-validated at the write sink, `spawn` is used without `shell:`, the orphan sweep is
symlink-aware, and the signal/`finally` cleanup paths share one idempotent guard.

All three findings are the same shape: a defense that is correct on the path it was written for, and
absent on a neighbouring one. Finding 1 scrubs credentials whenever `prepare()` returns but not when
it doesn't; Finding 2 guards the Codex config dir but not the Claude one; Finding 3 redacts
`trace.json` but not the file written four lines away. Each is worth closing at the structural level
— bind the scrub to the write, guard both adapters, and route every durable artifact through one
redaction path — rather than by patching the individual case.

The two open questions that could have changed this picture were settled by experiment after the
initial pass (§4, V1/V2), and they moved in opposite directions.

**V2 came out well.** The spawned `claude` binary does _not_ fall back to the macOS Keychain once
`HOME` and `CLAUDE_CONFIG_DIR` are redirected, so §9.3's Level 1 claim holds for the Claude
credential path and `detect()`'s `authUsable: false` is honest.

**V1 came out badly, and the two results compound.** Claude Code does read and use
`$CLAUDE_CONFIG_DIR/.credentials.json`. Because V2 established that the isolated run reaches no
other credential — no Keychain, and no env key in the default subscription-login setup — a
profile-supplied `.credentials.json` is not competing with anything. It is simply used. Finding 2 is
therefore a confirmed path from "run a shared profile" to "authenticate as its author", and the
lack of the reserved-path guard is what leaves it open.

That makes Finding 2 the one to close first, notwithstanding that Finding 1 is the one that can
trigger by accident.
