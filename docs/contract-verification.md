# Contract verification

For every entry in [`docs/contract.md`](contract.md), the evidence that it holds:
a test or a document. Required before the v1.0.0 release candidate is published
(ADR-0020, #149), because soaking a contract whose entries are not shown to hold
soaks an untested claim.

A row's evidence is a test file (and, where useful, the case) or a document. A
contract entry with neither is a gap, and is called out at the bottom.

## A. Stable surface

| Entry                           | Evidence                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands — `init`               | `test/integration/init.test.ts`                                                                                                                                |
| Commands — `doctor`             | `test/integration/doctor.test.ts`                                                                                                                              |
| Commands — `profile list`       | `test/e2e/contract-verification.test.ts` ("CLI surface")                                                                                                       |
| Commands — `inspect`            | `test/e2e/contract-verification.test.ts` ("CLI surface")                                                                                                       |
| Commands — `run`                | `test/e2e/cli-fixture-runtime.test.ts`, `test/integration/run-pipeline.test.ts`, `test/integration/run-parameters.test.ts`                                     |
| Commands — `runs`               | `src/cli/runs.test.ts`, `test/e2e/contract-verification.test.ts` ("run index")                                                                                 |
| Commands — `trace show`         | `test/e2e/contract-verification.test.ts` ("older trace", "full trace")                                                                                         |
| Commands — `clean`              | `test/integration/clean.test.ts`                                                                                                                               |
| Flags — `init`                  | `test/integration/init.test.ts`                                                                                                                                |
| Flags — `run`                   | `test/integration/run-parameters.test.ts`, `test/integration/cli-isolation-flag.test.ts`                                                                       |
| Flags — `--json`                | `test/e2e/contract-verification.test.ts` ("CLI surface" asserts each line has `level` and `message`); `test/integration/cli-errors.test.ts`                    |
| Resolution of run parameters    | `test/integration/run-parameters.test.ts`, `test/e2e/contract-verification.test.ts` ("e")                                                                      |
| Exit codes                      | See the exit-code table below.                                                                                                                                 |
| `--json` output                 | `test/e2e/contract-verification.test.ts` ("CLI surface"), `test/integration/{init,doctor,cli-errors,clean}.test.ts`                                            |
| Config schemas — `yuurei.yaml`  | `src/config/yuurei-config.test.ts`, `test/integration/init.test.ts`                                                                                            |
| Config schemas — `profile.yaml` | `src/profile/loader.test.ts`, `test/integration/task-path-boundary.test.ts`                                                                                    |
| `trace.json` fields + token     | `src/trace/schema.test.ts` (rejects a differing `schema_version`, accepts optional/absent fields), `test/e2e/contract-verification.test.ts` ("older trace")    |
| Requested-cell digest           | `src/cell/digest.test.ts`, `src/cell/resolver.test.ts`, `test/e2e/contract-verification.test.ts` ("requested-cell digest")                                     |
| Run directory + concurrency     | `src/run/layout.test.ts`, `test/integration/trace-publication.test.ts`                                                                                         |
| `patch.diff` + `workspace/`     | `src/run/workspace.test.ts`, `test/integration/workspace-patch.test.ts`                                                                                        |
| `artifacts.json`                | `src/artifact/collector.test.ts`                                                                                                                               |
| `resolved-profile.json`         | `test/integration/profile-materialization.test.ts`                                                                                                             |
| `trace show`                    | `test/e2e/contract-verification.test.ts`                                                                                                                       |
| Run index                       | `src/cli/runs.test.ts`, `test/e2e/contract-verification.test.ts` ("run index")                                                                                 |
| Runtime detection               | `src/runtime/minimum-version.test.ts` (declared minimum + boundary); the pinned versions are installed and exercised by `.github/workflows/e2e.yml` (document) |
| Supported platforms             | `.github/workflows/ci.yml` runs on `ubuntu-latest` and `macos-latest` (document)                                                                               |

### Exit codes

| Code | Evidence                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `test/e2e/cli-fixture-runtime.test.ts` (a run records `exit_code: 0` and the CLI exits 0)                                                                                     |
| 2    | `test/integration/cli-errors.test.ts`, `test/e2e/contract-verification.test.ts` ("configuration errors")                                                                      |
| 3    | `test/integration/init.test.ts` (unknown runtime), `test/integration/run-pipeline.test.ts` ("runtime gate"), `test/e2e/contract-verification.test.ts` (runtime not installed) |
| 4    | `test/integration/isolation-fail-closed.test.ts`                                                                                                                              |
| 5    | `src/index.ts` maps an unexpected (non-`YuureiError`) failure to 5; `test/integration/run-pipeline.test.ts` shows such errors propagate unwrapped. See the note below.        |
| 6    | `test/integration/trace-publication.test.ts` (a required-output write failure rejects with `TRACE_OR_ARTIFACT_SAVE_FAILED`)                                                   |
| 130  | `test/integration/signal-cleanup.test.ts` (SIGINT)                                                                                                                            |
| 143  | `test/integration/signal-cleanup.test.ts` (SIGTERM)                                                                                                                           |

**Note on 3 and 5.** Code 3 is "runtime not found or below the supported
minimum"; the pipeline checks this before creating a run directory, so a missing
or too-old runtime exits 3. Code 5 is the CLI's mapping for a failure that is
none of configuration (2), runtime support (3), isolation (4), or a save failure
(6) — an unexpected error. A runtime that **runs** and exits non-zero is not a
yuurei failure: it is recorded in the trace (`execution.exit_code`) and yuurei
exits 0, per design §12.2.

## B. Experimental surface

| Entry                                    | Evidence                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge flags never modify the real file  | `test/integration/global-config-untouched.test.ts`                                                                                                 |
| Bridge copy scrubbed, including `--keep` | `test/integration/signal-cleanup.test.ts`, `test/integration/profile-materialization.test.ts`, `test/integration/opencode-materialization.test.ts` |
| Auth method reaches the digest           | `test/integration/global-config-untouched.test.ts`, `test/integration/opencode-materialization.test.ts`                                            |

## C. Security invariants

| Invariant                                              | Evidence                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real global config never renamed/moved/deleted         | `test/integration/global-config-untouched.test.ts`                                                                                                                  |
| Secrets never recorded in `trace.json`                 | `test/integration/trace-publication.test.ts`, `test/e2e/opencode-fixture-runtime.test.ts` (auth-failure trace carries no runtime text)                              |
| Credentials never copied into a profile                | `src/profile/loader.test.ts`, `test/integration/profile-materialization.test.ts`                                                                                    |
| No redirect to the shared OS credential store          | `src/runtime/codex/args.test.ts` (forces `cli_auth_credentials_store="file"`)                                                                                       |
| Runtime not started when isolation verification fails  | `test/integration/isolation-fail-closed.test.ts`                                                                                                                    |
| A failed bridge leaves the run unauthenticated         | `test/integration/profile-materialization.test.ts`                                                                                                                  |
| Credential material scrubbed on cleanup, even `--keep` | `test/integration/signal-cleanup.test.ts`, `test/integration/profile-materialization.test.ts`                                                                       |
| Path validation / isolation / bridge fail closed       | `src/util/fs.test.ts`, `test/integration/task-path-boundary.test.ts`, `src/runtime/opencode/config-guard.test.ts`, `test/integration/isolation-fail-closed.test.ts` |

## D. Best-effort behaviour

| Entry                                    | Evidence                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Log redaction                            | `src/trace/redact.test.ts`, `test/integration/run-pipeline.test.ts`                                  |
| Orphaned temp dirs after a hard crash    | `src/isolation/tempdir.test.ts`, `test/integration/doctor.test.ts`, `test/integration/clean.test.ts` |
| Credential staleness with a bridge       | Documented in the contract and the adapters' bridge comments (by nature not testable in CI)          |
| Secrets in `workspace/` are not scrubbed | `test/integration/workspace-patch.test.ts` (workspace stored as produced)                            |
| Artifact size cap and log truncation     | `src/artifact/collector.test.ts`, `test/integration/workspace-patch.test.ts`                         |

## Versioning, deprecation and Not covered

These are policy statements, not runnable behaviour. Their evidence is the
documents themselves:

- **Versioning** and **Deprecation** — [`docs/adr/0012-versioning-and-deprecation-policy.md`](adr/0012-versioning-and-deprecation-policy.md).
- **Not covered** — the contract's own text and design §12.1.

## Gaps found and closed

Checked before the RC (this is what #149 asked for). Each is now evidence-backed:

- **`profile list` and `inspect` had no test.** Added to
  `test/e2e/contract-verification.test.ts` ("CLI surface").
- **The `--json` line shape had no general test.** The same describe asserts each
  line carries `level` and `message`.
- **Exit code 6 was never emitted.** A failure to persist a required output
  (logs, `artifacts.json`, `resolved-profile.json`, `trace.json`) now throws
  `TRACE_OR_ARTIFACT_SAVE_FAILED`; asserted in
  `test/integration/trace-publication.test.ts`.
- **Exit code 3 was not emitted by `run`.** A runtime that is not installed, or
  is below its declared minimum, is checked before any run directory is created
  and exits 3; asserted in `test/integration/run-pipeline.test.ts` and
  `test/e2e/contract-verification.test.ts`.
