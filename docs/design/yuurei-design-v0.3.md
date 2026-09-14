# yuurei Design Document v0.3

- **Status**: Implementation Ready
- **Updated**: 2026-09-14
- **Scope**: The `yuurei` lower-layer tool, and its boundary with a future ROI tracker
- **Former working name**: `harnessenv`

---

## 0. Executive Summary

`yuurei` is a CLI tool that reproduces a coding agent's execution environment and harness configuration in isolation from the user's everyday global environment.

Its purpose is to let skills, instructions, settings, hooks, and other configuration be switched safely across runtimes such as Claude Code and Codex, creating comparable execution cells **without evacuating or destroying the user's everyday environment**.

Think of the model as the "ground" and the harness as the "building." Even with the same building, performance changes if the ground changes; even with the same ground, results change depending on how the building is configured. `yuurei` is the lower-layer foundation that separates that combination into a reproducible unit.

A future ROI tracker will sit above it, comparing quality, cost, time, success rate, and similar metrics. The dependency direction is always as follows.

```text
ROI Tracker  ──────>  yuurei
   upper                lower

※ yuurei knows nothing about the ROI tracker
```

In v0.3, Claude Code and Codex are treated as separate, native execution cells. Automatically porting the same harness across different runtimes, and support for local LLMs, are Future Plans and are not part of the current implementation scope.

---

## 1. Background

In everyday coding-agent environments, the following elements accumulate in global scope.

- User instructions
- Skills
- Agent definitions
- Hooks
- MCP and external tool configuration
- Permission/approval settings
- Runtime-specific settings
- Custom planning, review, and integration flows

Comparing a different configuration under this state requires evacuating, swapping, restarting, and restoring the existing configuration. As the number of comparison targets grows, this work becomes increasingly fragile, producing the following problems.

1. The everyday environment leaks into comparison experiments
2. The original state may not be restorable after execution
3. It is hard to record what was enabled during a given run
4. Model differences and harness differences cannot be separated
5. Configuration formats and startup methods differ per runtime

`yuurei` is not an evaluator itself — it is the **isolation, configuration, execution, and recording foundation** for solving these problems.

---

## 2. Product Principle

### 2.1 In one sentence

> Launch a temporary execution environment that carries only the specified harness configuration, without touching the everyday agent environment.

### 2.2 Core metaphor

The name `yuurei` overlays UREI's isolators with the Japanese word for "ghost" (幽霊).

- **Isolator**: separates mixed elements and leaves only the needed band
- **Ghost (幽霊)**: does not leave a permanent trace; appears temporarily and disappears
- **yuurei**: a temporary harness environment isolated from the global environment

The name connects audio-equipment isolation with software execution-environment isolation.

### 2.3 Design principles

1. **No contamination** — never modify the user's existing global configuration
2. **Reproducible** — the same execution cell can be rebuilt from the same definition
3. **Runtime-independent core** — runtime-specific processing is confined to adapters
4. **Transparent** — record the configuration and launch information actually used
5. **Small and composable** — don't embed evaluation or UI; be usable from a higher layer
6. **Fail safe** — refuse to execute when isolation cannot be guaranteed

---

## 3. Goals / Non-Goals

### 3.1 Goals

The goals for v0.3 are as follows.

- Isolated execution of Claude Code
- Isolated execution of Codex
- Declarative switching of harness profiles
- Execution that never modifies the user's everyday global configuration
- A fresh temporary workspace per execution
- Recording the effective configuration, command, exit state, and produced artifacts
- Emitting a common trace that higher-layer tools can consume
- A minimal interface that tolerates future runtime additions

### 3.2 Non-Goals

The following are not implemented in v0.3.

- Automatic scoring of output quality
- ROI ranking or dashboards
- Statistical significance testing
- Automatic conversion of the same harness between Claude Code and Codex
- Standardizing skill or instruction formats
- Automatic harness optimization
- Direct support for local LLMs
- VM- or container-grade OS isolation
- Cloud-distributed execution
- Team authentication/authorization management

---

## 4. v0.3 Scope: Pattern A Only

### 4.1 Adopted: Pattern A

Each runtime is measured as an independent cell that keeps its own native format.

```text
Cell A
  Runtime: Claude Code
  Model: A Claude-family model
  Harness: Claude Code profile

Cell B
  Runtime: Codex
  Model: An OpenAI-family model
  Harness: Codex profile
```

The comparison target is not "the model alone," but the following combination of everything that actually exists.

```text
runtime × model × native harness × task
```

### 4.2 Not adopted: Pattern B

The following is out of scope for v0.3.

```text
A single abstract harness
   ├── Converted to Claude Code format
   └── Converted to Codex format
```

Semantics such as instruction priority, skills, tools, permissions, hooks, and context management differ between runtimes. A surface-level file conversion would not produce identical conditions, so cross-runtime porting is sent to Future Plan as an independent research/design topic.

---

## 5. Architecture

```text
┌────────────────────────────────────────────┐
│ User / Script / Future ROI Tracker         │
└──────────────────────┬─────────────────────┘
                       │ CLI / Process / Trace
┌──────────────────────▼─────────────────────┐
│ yuurei                                     │
│                                            │
│  Profile Loader                            │
│  Cell Resolver                             │
│  Isolation                                 │
│  Runtime Adapter                           │
│  Trace Writer                              │
│  Artifact Collector                        │
│  CostModel boundary                        │
└───────────────┬─────────────────┬──────────┘
                │                 │
       ┌────────▼────────┐ ┌──────▼──────────┐
       │ Claude Code     │ │ Codex           │
       │ native config  │ │ native config   │
       └─────────────────┘ └─────────────────┘
```

### 5.1 Logical layers

1. **Profile** — declares which configuration to use
2. **Cell** — the resolved combination of runtime, model, harness, and task
3. **Isolation** — builds the temporary directory and environment variables
4. **Runtime** — launches the target CLI
5. **Trace** — records the facts of execution in a common format
6. **Artifact** — collects patches, logs, generated files, and the like
7. **CostModel** — provides only the boundary that converts usage into an amount

### 5.2 Physical split

v0.3 does not necessarily split into multiple repositories. Logical boundaries are enforced in code first.

`yuurei` and the ROI tracker will be physically separated once standalone publication or responsibility separation becomes necessary.

---

## 6. Four Stable Interfaces

To allow future extension toward local LLMs and new runtimes without a full rewrite, v0.3 introduces the following four boundaries.

### 6.1 `Runtime`

Hides runtime-specific launch, inspection, and termination handling.

```ts
interface Runtime {
  id(): string;
  detect(): Promise<RuntimeDetection>;
  prepare(cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun>;
  execute(run: PreparedRun): Promise<RuntimeResult>;
  normalize(result: RuntimeResult): Promise<NormalizedTraceFragment>;
}
```

Responsibilities:

- Checking whether the CLI exists and which version it is
- Assembling launch arguments
- Setting runtime-specific environment variables
- Capturing stdout, stderr, and the exit code
- Converting runtime-specific logs into the common trace

Initial implementations:

- `ClaudeCodeRuntime`
- `CodexRuntime`
- `OpenCodeRuntime` (experimental; issue #106 — see §20. Implemented and security-reviewed)

Runtime-specific configuration paths and CLI arguments are confined inside each adapter. External specifications are expected to change, so fixed values must not leak into the core.

### 6.2 `Isolation`

Builds a temporary execution environment isolated from the user's global configuration.

```ts
interface Isolation {
  create(cell: ResolvedCell): Promise<IsolationContext>;
  verify(context: IsolationContext): Promise<IsolationReport>;
  dispose(context: IsolationContext): Promise<void>;
}
```

Responsibilities:

- Creating a temporary HOME or a runtime-specific configuration root
- Copying or linking profile material
- Restricting the writable area
- Verifying that the original global configuration is not being referenced
- Cleanup on both normal and abnormal termination

**Fail-closed principle**: if isolation status cannot be verified, the runtime must not start.

### 6.3 `TraceSchema`

A common, runtime-independent execution record format.

At minimum, it holds the following.

```json
{
  "schema_version": "0.3",
  "run_id": "...",
  "started_at": "...",
  "finished_at": "...",
  "runtime": {
    "id": "claude-code",
    "version": "..."
  },
  "model": {
    "requested": "...",
    "resolved": "...",
    "resolved_reason": "observed"
  },
  "profile": {
    "name": "...",
    "digest": "sha256:..."
  },
  "task": {
    "source": "...",
    "digest": "sha256:..."
  },
  "isolation": {
    "strategy": "...",
    "verified": true
  },
  "execution": {
    "exit_code": 0,
    "signal": null,
    "duration_ms": 0,
    "timed_out": false
  },
  "usage": {},
  "cost": null,
  "artifacts": [],
  "diagnostics": []
}
```

`execution.signal` is the OS signal name (`"SIGINT"`, `"SIGTERM"`, etc.) when the runtime child
was killed by a signal, or `null` otherwise. When a signal is recorded, `exit_code` is `null`
because the process had no exit code to report. A run interrupted by a signal that yuurei itself
caught (SIGINT/SIGTERM during the run) produces no durable run directory (the partial directory
is removed before exit); a signal delivered to the runtime child after the pipeline completes
execution produces a valid trace with `signal` set and `exit_code: null`.

The trace distinguishes "a value that could not be observed" from "zero." It never fills in an unknown value by guessing.

`model.resolved_reason` is a machine-readable reason for the value of `model.resolved`, so a consumer does not have to parse prose to tell "not observed" from "observation failed." Values are `observed` (the effective model was seen), `unobserved` (the runtime produced no model identity), and `parse_failed` (an expected source existed but could not be read). It is omitted when `resolved` is non-null.

`diagnostics` is an array of non-fatal, secret-free notes produced while normalizing a run (for example, malformed runtime output lines or a usage metric that was unobserved). This is distinct from the adapter's `warnings`, which are surfaced to the operator via `onWarning` and are not persisted to the trace (§9.2); `diagnostics` is the durable record. Diagnostics must never contain credential values.

Both fields are **additive and optional**. Per §6.3's versioning intent, adding an optional field that older readers ignore (and that new readers tolerate as absent) does not change the on-disk contract, so `schema_version` stays `0.3`. This avoids breaking `yuurei trace show` on run directories written by an earlier build.

### 6.4 `CostModel`

The boundary that converts usage into currency, compute resources, time, and the like.

```ts
interface CostModel {
  id(): string;
  estimate(input: UsageRecord): Promise<CostEstimate>;
}
```

v0.3 does not aim for a complete pricing calculation. Pricing schemes are subject to change, so the trace retains raw usage and the basis for calculation so it can be recomputed later.

When local LLM support arrives, metrics such as the following can be implemented instead of API pricing.

- Execution time
- GPU time
- Estimated power consumption
- Memory usage
- Any cost including depreciation of equipment

However, these are out of scope for the current implementation.

---

## 7. Profile and Cell Model

### 7.1 Recommended directory layout

```text
.yuurei/
├── yuurei.yaml
├── profiles/
│   ├── claude-pstack/
│   │   ├── profile.yaml
│   │   └── config/
│   ├── claude-custom/
│   │   ├── profile.yaml
│   │   └── config/
│   └── codex-pstack/
│       ├── profile.yaml
│       └── config/
└── tasks/
    └── refactor.md
```

### 7.2 Example `yuurei.yaml`

```yaml
version: 1

profiles:
  claude-pstack:
    runtime: claude-code
    source: ./profiles/claude-pstack

  claude-custom:
    runtime: claude-code
    source: ./profiles/claude-custom

  codex-pstack:
    runtime: codex
    source: ./profiles/codex-pstack

runs:
  refactor-claude-pstack:
    profile: claude-pstack
    task: ./tasks/refactor.md

  refactor-claude-custom:
    profile: claude-custom
    task: ./tasks/refactor.md

  refactor-codex-pstack:
    profile: codex-pstack
    task: ./tasks/refactor.md
```

### 7.3 Requested cell identity

A cell is identified by **what was requested of it**, digested as follows.

```text
requested_cell_digest = hash(
  runtime identity,
  requested model,
  resolved profile contents,
  task contents,
  isolation strategy,
  identity-forming execution contracts
)
```

The hash target is not a mere profile name, but its **resolved content**.

An earlier revision of this formula listed the `yuurei` version, omitted the
isolation strategy, and called the result `cell_digest`. All three are corrected
above; the reasoning is in `docs/adr/` and summarized here so the change is not
read as a slip.

**The digest is named for what it identifies.** `cell_digest` promised the
identity of the cell that ran, while what is hashed is the identity of the cell
that was _asked for_ — a name that claims more than it delivers is not repaired
by a note saying so. It is `requested_cell_digest`, recorded as
`requested_cell.digest`, which puts it in the same vocabulary as
`model.requested`.

**The `yuurei` version is no longer part of cell identity.** Hashing it meant
that every release — including a patch touching only documentation — produced a
different digest for the same definition, while the runtime's own version was
never hashed at all, so upgrading the coding agent left identity unchanged. A
key that is strict about the orchestrator and silent about the agent is not the
conservative key it appears to be. The version is instead recorded as an
observed property of the run, alongside the runtime version and the resolved
model.

It follows that **equal digests do not mean two runs executed under identical
conditions.** They mean the same thing was requested. To see what actually ran,
read the observed fields: the `yuurei` version, the runtime version, and the
resolved model. A consumer that wants the stricter grouping composes the digest
with those fields; the reverse — widening a key that already has them baked in —
is not available.

**The isolation strategy has always been part of cell identity** in the
implementation, since level0 and level1 give the runtime materially different
`HOME` and configuration semantics (§9.3). The formula omitted it; the code did
not.

---

## 8. CLI Surface

The CLI is kept small.

```bash
# Check available runtimes and their status
yuurei doctor

# List profiles
yuurei profile list

# Show the resolved configuration without executing
yuurei inspect claude-pstack

# Execute a single cell
yuurei run refactor-claude-pstack

# Specify a profile and a task directly
yuurei run --profile codex-pstack --task ./tasks/refactor.md

# Keep the isolated environment for debugging
yuurei run refactor-claude-pstack --keep

# Show an existing trace
yuurei trace show <run-id>

# Remove isolation temp directories orphaned by abnormal termination
yuurei clean
```

### 8.1 `doctor`

Checks performed:

- Is the target CLI installed?
- Is it a supported version?
- Is the authentication state usable?
- Can the isolation strategy be constructed?
- Is there any unintended reference to global configuration?
- Is the output destination writable?

`doctor` never corrects the environment — it is limited to inspection and displaying remediation suggestions.

### 8.2 `clean`

`doctor` detects `yuurei-*` temp directories in the OS temp root that were orphaned by abnormal termination (`SIGKILL`, power loss, hard crash — the cleanup paths in §9.1 cannot run in those cases). `clean` is the recovery half of that safety regression (§15): it finds the same orphaned directories and removes those older than a threshold (24h by default) so an in-progress run is never touched. Deletion is best-effort; failures are reported, not fatal.

### 8.3 Exit codes

Examples:

- `0`: Execution succeeded
- `2`: Configuration error
- `3`: Runtime not found or unsupported
- `4`: Isolation verification failed
- `5`: Runtime execution failed
- `6`: Trace or artifact save failed

---

## 9. Isolation Strategy

### 9.1 Required conditions

- Never rename, move, or delete the user's original global configuration
- Record the absolute path of the temporary environment
- Inspect the effective configuration before execution
- Delete the temporary area after execution finishes
- Keep it only for debugging when `--keep` is specified
- Clean up as much as possible even on signal or abnormal termination

### 9.2 Credentials

Credentials are handled separately from harness configuration.

- Never copy credentials into a profile
- Never record secrets into the trace
- When reusing existing authentication, the runtime adapter references it only through an approved method
- Strip tokens, cookies, API keys, and auth headers from logs
- Once credential bridging is enabled, profile and task content becomes a trust boundary: bridged credentials are reachable from anything a profile's hooks, settings, or commands can run inside the isolated environment (e.g. a forwarded `ANTHROPIC_API_KEY`, or the isolated `CODEX_HOME`'s `auth.json`), so profiles and tasks must be trusted the same way executable code is
- The supported v0.3 credential mechanism is an explicitly-set, non-rotating API key forwarded into the isolated environment (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` for Claude Code, `OPENAI_API_KEY` for Codex) — always on, since forwarding an env var writes nothing to disk and carries no rotation risk
- Reusing an interactive ChatGPT login by copying `~/.codex/auth.json` is experimental and opt-in only (off by default): that file can carry a rotating OAuth access/refresh token pair, and yuurei's copy-run-discard lifecycle cannot safely reconcile a mid-run token refresh — the isolated copy may receive the rotated, valid state while the real file stays stale, and the rotated copy is then discarded on cleanup. Writing the rotated state back to the real file would fix this but is explicitly rejected: it would violate the "never modify the user's existing global configuration" guarantee (§2.3, §9.1). Any credential material this mechanism does write to disk is scrubbed on cleanup on a best-effort basis, including when `--keep` is set (`--keep` preserves config and logs for debugging, never credentials) — a failed deletion is surfaced to the operator as a warning naming the residual path rather than silently swallowed, but is not fail-closed: it does not abort the run. On `SIGINT`/`SIGTERM` the same cleanup runs via a signal handler (the process exits with the shell-convention code, 130/143); only an uncatchable `SIGKILL` or a hard crash can still bypass cleanup entirely, which is left to the orphan-recovery path (§15, tracked separately)
- The runtime adapter's own CLI invocation forces the credential-storage backend at the highest-precedence layer available (e.g. Codex's `-c cli_auth_credentials_store="file"`), regardless of what a materialized profile's own config might request — a profile must not be able to redirect authentication to the operator's shared OS credential store (keychain) just by shipping a config file that asks for it
- **OpenCode** (issue #106, contract in §20) stores credentials in a file (`<data>/opencode/auth.json`; no OS-keychain backend was observed), so the "no redirect to a shared keyring" clause is nearly vacuous — but OpenCode config supports `{file:path}` substitution that resolves `~`, absolute, and relative paths. A spike confirmed a profile-supplied `provider.*.options.apiKey: "{file:~/.local/share/opencode/auth.json}"` reads the operator's real credential store under Level 0. The adapter therefore must reject, at the profile-materialization boundary and before OpenCode starts, any `{file:...}` reference that resolves outside the cell (fail closed), not merely a reserved file name. It must also reject a literal `apiKey` value, which would otherwise be written into the cell's config and survive `--keep` as a profile-supplied credential (§20.5)

### 9.3 Isolation levels

v0.3's isolation is primarily at the configuration/environment level, and is not a complete security boundary against malicious code.

```text
Level 0: Swapping arguments / configuration root
Level 1: Temporary HOME with restricted environment variables
Level 2: Container or OS sandbox (Future)
Level 3: VM / remote isolation (Future)
```

The initial implementation targets Level 0–1.

OpenCode resolves its config, data, state, and cache roots from the four `XDG_*` variables and its scratch root from `TMPDIR`. Level 1 isolates these implicitly through the temporary `HOME`; Level 0 keeps the operator's real `HOME`, so the OpenCode adapter sets `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` and `TMPDIR` to cell paths explicitly at the adapter layer — the OpenCode analog of `CLAUDE_CONFIG_DIR` / `CODEX_HOME` (§20). A spike confirmed that without the `XDG_*` overrides OpenCode reads the operator's real global config, and that without `TMPDIR` it writes to a fixed `/tmp/opencode` outside the cell.

---

## 10. Trace and Artifacts

Execution results are saved as follows.

```text
.yuurei/runs/<run-id>/
├── trace.json
├── resolved-profile.json
├── stdout.log
├── stderr.log
├── artifacts.json
├── patch.diff
└── workspace/
```

What is actually saved is configurable, and secrets or oversized files are not duplicated without limit.

`stdout.log`/`stderr.log` are not a byte-for-byte copy of what the runtime produced: known bridged credential values and generic secret-shaped patterns are redacted before persisting (§9.2, §10.2), so a run that printed a credential to its own output will not have that value recoverable from the durable run directory — but this is a best-effort text pass over whatever the runtime happened to emit, not a content-aware guarantee.

### 10.1 What is recorded

- Execution timestamp
- `yuurei` version
- Runtime name and version
- Requested model and the observed effective model
- The requested-cell digest (§7.3), with an identifier for the input set that
  produced it
- Digest of the profile content
- Digest of the task content
- The execution contracts that constitute cell identity — the timeout and the
  adapter-owned options that feed the cell digest
- Isolation strategy and its verification result
- Execution duration
- Exit code
- Observable usage
- The artifacts the run produced, and where they are

Two entries above were narrowed from an earlier, broader wording; the reasoning
is recorded in `docs/adr/` and summarized here so this section is not read as the
promise it used to make.

**Execution contracts, not every launch option.** An earlier revision said
"Launch options", which reads as a promise to record every flag. Most launch
options are in fact recorded, but under their own names rather than a single
heading: `--profile` and `--task` appear as the profile and task entries above,
`--model` as the requested model, `--isolation` as the isolation strategy. The
residue is `--keep`, which is deliberately **not** recorded. Retention is outside
the trace's responsibility: `--keep` preserves the temporary cell for debugging
and changes nothing about which cell ran or how it ended, and the run directory
persists either way. See ADR-0008 and ADR-0009.

**Artifacts are named here; their content is attested in `artifacts.json`.** An
earlier revision said "artifacts and their digests", which reads as a promise that
the trace carries the digests. It does not, by design: the trace names what the
run produced and where it is, and `artifacts.json` is authoritative for every
property of the stored bytes — the digest, and whether they were truncated. Note
that such a digest covers the bytes **as stored** — after redaction (§10.2) and
any truncation — not the bytes the runtime originally emitted. See ADR-0008.

### 10.2 What is not recorded, in principle

- API keys
- Auth tokens
- Cookies
- OS keychain contents
- Files the user explicitly excluded
- Secrets generated by the runtime

---

## 11. ROI Tracker Boundary

The ROI tracker is a separate layer that takes `yuurei`'s traces and artifacts as input.

```text
yuurei:
  isolate -> execute -> observe -> emit trace

ROI tracker:
  schedule -> repeat -> evaluate -> compare -> report
```

Functions the upper layer will own in the future:

- Repeated execution of the same cell
- A model × harness comparison matrix
- Leave-one-out ablation
- Quality evaluation
- Success rate
- Aggregating time, tokens, and cost
- Pareto frontier
- Counterfactual comparison
- Report generation

`yuurei`, the lower layer, does not contain evaluation logic or ranking logic.

---

## 12. Security and Failure Handling

### 12.1 Threat model

What v0.3 primarily protects against:

- Overwriting the everyday global configuration
- Unintended configuration leakage from another profile
- Forgetting to restore state after an experiment
- Missing records of execution conditions

What v0.3 does not protect against:

- Malicious OS operations performed by the code under execution
- Vulnerabilities in the runtime itself
- Network-based attacks
- Complete process/filesystem isolation
- Concurrent adversarial mutation of profile/task files during materialization: symlink checks (e.g. `isPathWithin`) are check-then-read, not atomic, so a filesystem actor racing the check is out of scope
- **OpenCode admin-controlled configuration** (issue #106): OpenCode reads managed config from an absolute, non-redirectable location (`/Library/Application Support/opencode/` and the `ai.opencode.managed` preference domain on macOS; `/etc/opencode/` on Linux) and can fetch organizational defaults from a remote `.well-known/opencode` endpoint. These are treated as trusted, administrator-controlled inputs rather than "the operator's global configuration": a profile cannot write them, so they do not widen what a profile can reach. They are accepted risks because they are read from outside the cell and cannot be redirected by the adapter. The first OpenCode implementation must reconcile this explicitly against the "never read the operator's global configuration" goal rather than silently leaving it
- **OpenCode provider-key environment variables**: the supported bridging path forwards explicitly-set provider API keys (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) from the parent environment. Enumerating which keys are forwarded is adapter-owned (§20); keys outside the allowlist are not forwarded

### 12.2 Handling of failure

Execution failure is also retained in the trace as an observed result.

- Setup failure
- Isolation verification failure
- Authentication failure
- Timeout
- User interruption
- Runtime abnormal termination
- Artifact collection failure

However, if isolation verification fails, the runtime is not started.

---

## 13. Implementation Plan

### Phase 0 — Spike

- A minimal experiment proving configuration isolation works for Claude Code
- A minimal experiment proving configuration isolation works for Codex
- Non-interactive execution and exit-code capture for each runtime
- Verification that global configuration is not modified

### Phase 1 — Core

- Profile Loader
- Cell Resolver
- The `Isolation` interface
- The `Runtime` interface
- Temporary directory management
- `yuurei doctor`
- `yuurei inspect`

### Phase 2 — Runtime Adapters

- `ClaudeCodeRuntime`
- `CodexRuntime`
- Building the effective command
- Capturing stdout/stderr
- Timeout and signal handling

### Phase 3 — Trace

- The common trace schema
- Digesting profiles and tasks
- Artifact collection
- Stripping secrets from logs
- A no-op implementation of `CostModel`

### Phase 4 — Hardening

- Cleanup on abnormal termination
- Avoiding collisions across parallel executions
- Path and symlink inspection
- Controlling large logs
- Supported-version checks
- Adding dogfooding examples

---

## 14. Acceptance Criteria

v0.3 is considered complete when:

1. Two or more Claude Code profiles can be switched without touching global configuration
2. One or more Codex profiles can be executed without touching global configuration
3. The same cell digest can be regenerated from the same profile and task
4. Every execution produces a `trace.json` in the common format
5. Runtime-specific information does not leak unnecessarily outside the `Runtime` adapter
6. Execution is refused whenever isolation cannot be verified
7. On execution failure, the cause and state are retained in the trace as far as possible
8. Secrets such as API keys are never saved into the standard trace
9. `yuurei` has practical value on its own, without implementing ROI evaluation features
10. A higher-layer tool can consume it via the CLI or the trace

---

## 15. Test Strategy

### Unit

- Configuration resolution order
- Profile digest
- Cell digest
- Path normalization
- Stripping secrets from logs
- Trace schema validation

### Integration

- Success, failure, and timeout with a fake runtime
- Creation and teardown of a temporary HOME or configuration root
- `--keep` behavior
- Consecutive execution of multiple cells
- Launch inspection for the Claude Code/Codex adapters

### Safety Regression

- The mtime, content, inode, etc. of the original global configuration do not change
- Configuration outside the profile does not leak into the effective environment
- Secrets are not output into the trace
- Orphaned temporary areas can be detected after abnormal termination

---

## 16. Future Plan

### 16.1 Pattern B: Cross-Runtime Harness Portability

Converting and placing a harness that carries the same intent across multiple runtimes while preserving its semantics.

Open questions this would require:

- A common harness IR
- Converting instruction priority
- Mapping skill/agent concepts
- Expressing differences in tool capability
- Hook compatibility
- Declaring elements that cannot be converted
- Equivalence testing

This is not a file-copy feature — it is treated as an independent design problem.

### 16.2 Local LLM / Mac Studio

A local LLM runtime running on a Mac Studio or similar is a future addition target. However, the current design does not assume local LLMs as a premise.

Future additions will go through the four boundaries: `Runtime`, `TraceSchema`, `CostModel`, and `Isolation`.

Candidate additional observations:

- Inference time
- Tokens/sec
- First-token latency
- GPU/memory usage
- Power consumption
- Model load time

### 16.3 Stronger Isolation

- Containers
- macOS sandbox equivalent
- VMs
- Remote workers
- Read-only workspace + patch output

### 16.4 Team Use

- Shared profiles
- Policy inspection
- CI execution
- Regression evaluation for harness changes
- Signed profiles
- Centralized management of execution evidence

---

## 17. Naming Decision Record

### Decision

The lower-layer isolation tool is named **`yuurei`**.

### Origin

- The "separating" operation of UREI-series isolators
- The Japanese word for "ghost" (幽霊)
- The property of not leaving a permanent trace — appearing as a temporary environment and disappearing
- A short lowercase name carrying music-culture heritage, alongside `mumbl` and `mdub`

### Other candidates

- `marci` — a metaphor for "drumless," i.e. ablation as removing an element
- `rekit` — a metaphor for decomposing material ReCycle-style and reassembling it as a kit

`marci` was not adopted due to the indirectness of its meaning, and `rekit` due to a name collision with an existing development tool.

### Notation

- Product/CLI/package: `yuurei`
- Configuration directory: `.yuurei/`
- Configuration file: `yuurei.yaml`
- Environment variable prefix: `YUUREI_`

---

## 18. Decisions Frozen for v0.3

The following are not reopened during v0.3 implementation.

- The lower-layer tool is named `yuurei`
- Claude Code and Codex are the target runtimes
- Both are treated as separate native cells
- The OpenCode adapter (issue #106, contract in §20) is an explicitly tracked extension of this set. It is implemented under the same `Runtime` boundary, marked experimental, and is listed in the user-facing docs alongside Claude Code and Codex now that its implementation and required security review have landed
- Cross-runtime porting is not implemented
- Local LLMs are not a current premise
- The four boundaries `Runtime` / `Isolation` / `TraceSchema` / `CostModel` are established
- The ROI tracker is a separate layer
- The dependency direction is one-way only, from the ROI tracker to `yuurei`
- Logical separation comes first; physical repository splitting happens only when needed

---

## 19. First Implementation Task

The first implementation task is not to broaden functionality, but to run a vertical spike that verifies the following hypothesis.

> For both Claude Code and Codex, can we execute non-interactively from a temporary environment that carries only the specified profile — without changing the user's everyday global configuration — and retain a common trace?

Minimum deliverables:

1. `yuurei doctor`
2. One Claude Code profile
3. One Codex profile
4. One common task
5. One isolated execution each
6. Two `trace.json` files
7. A verification log showing that global configuration was not modified

Once this vertical slice succeeds, profile management, multiple executions, and artifact collection can be expanded.

---

## 20. OpenCode Runtime Adapter — Contract (issue #106)

This section locks the OpenCode adapter contract, verified by a read-only spike
before implementation. Raw evidence and reproduction steps live in
[`docs/design/spike/opencode-contract.md`](spike/opencode-contract.md) and
[`scripts/spike/opencode-contract.sh`](../../scripts/spike/opencode-contract.sh).
OpenCode is marked experimental and listed in the user-facing docs now that the
adapter and its required security review
(§`docs/security/review-policy.md`; record:
`docs/security/reviews/opencode-adapter-2026-09-14.md`) have landed.

### 20.1 Minimum supported version

`>= 1.18.0`. The contract below was verified on both `1.18.0` and `1.18.30`.
Version detection uses `opencode --version`, which prints a bare semver and is
parsed by the existing `isVersionAtLeast` helper.

### 20.2 Launch

```
opencode run --format json --auto [-m provider/model] <task>
```

- `--format json` emits newline-delimited JSON events.
- `-m` takes `provider/model`; `cell.requestedModel` is passed through verbatim,
  so a caller must supply the provider-qualified form.
- `--auto` is required for a non-interactive coding run: without a TTY and
  without this flag OpenCode auto-rejects permission requests.
- The task is passed as a positional argument. `execCapture` spawns the child
  with stdin at EOF, so OpenCode's stdin read returns empty rather than hanging.
- The adapter does not set `--dir`; the pipeline already spawns with
  `cwd = isolation.rootDir`.

### 20.3 Environment the adapter sets

In addition to `isolation.env`:

- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`,
  `TMPDIR` — all directed into the cell. Required at both levels; Level 0 in
  particular keeps the real `HOME`, and `TMPDIR` is otherwise fixed to
  `/tmp/opencode` outside the cell.
- `OPENCODE_DISABLE_AUTOUPDATE=1` — no self-update during a run.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` — do not read an `opencode.json` found by
  walking up from the cell's cwd.
- `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` — do not import the operator's
  `~/.claude/skills` or `~/.agents/skills` (confirmed imported by default; this
  matters under Level 0).

### 20.4 Config materialization

Profile `config/` files are written under `<XDG_CONFIG_HOME>/opencode/` (the
OpenCode global config directory), and OpenCode's data/state/cache stay in their
own cell directories. OpenCode may auto-create a minimal `opencode.jsonc` and
`.gitignore` in that directory when none exists; the adapter must ensure this
does not silently override or conflict with profile-supplied config.

### 20.5 File-reference guard (fail closed)

OpenCode config supports `{env:VAR}` and `{file:path}` substitution, where a
`file` path may be relative to the declaring config, absolute, or `~`-rooted. A
spike confirmed a profile config can read an arbitrary path, including the
operator's real credential store under Level 0. At the profile-materialization
boundary, before OpenCode starts, the adapter rejects any `{file:...}` reference
that resolves — after relative/`~`/`..` normalization — outside the cell,
including the operator's real `HOME`, each real `XDG_*` directory, `~/.claude`,
`~/.codex`, and the managed-config paths. Symlinks and parent directories are
resolved, and resolution is **strict**: only `ENOENT` falls back to the lexical
path, so a permission or symlink-loop failure refuses the run rather than being
treated as absent. `~` and `~/...` expand against the runtime HOME; other tilde
forms (`~user`) are refused rather than mis-resolved, and if HOME is absent from
the isolated environment (the runtime would then resolve `~` through the passwd
entry, which the guard cannot see) every `~` reference is refused rather than
expanded to a path that diverges from what the runtime will actually read.

JSON and JSONC config files are parsed (comments and trailing commas tolerated)
and inspected on **decoded** values, so a JSON string escape — `\u007e`,
`\/`, or an escaped key such as `api\u004bey` — cannot hide a reference or a
credential from the check. Line comments end at LF or CR; an unterminated block
comment is treated as a parse failure. A JSON config that fails to parse, or a
comment that never terminates, is refused (fail closed). Non-JSON config files
are scanned as raw text as defense-in-depth.

The adapter also rejects a **literal** `apiKey` value in profile config. A
profile that hardcodes a provider key would have it materialized into the cell's
config and — unlike the opt-in `auth.json` bridge, which is registered for
scrubbing — left on disk under `--keep`. The value must be a single
substitution (`{env:...}` or `{file:...}`) with nothing around it; an empty or
whitespace value, a literal, or a substitution with a literal prefix/suffix is
refused, and a `{file:...}` one is still containment-checked. This applies to
any key named `apiKey`/`api_key` at any depth. This is the OpenCode equivalent
of Codex's reserved `auth.json` rejection.

### 20.6 Credential bridging

- **Supported:** forward explicitly-set provider API keys from the parent
  environment through a fixed, adapter-owned allowlist (documented in the
  adapter); their values are added to `credentialValuesToRedact`. This is the
  default path and writes nothing to disk.
- **Experimental, opt-in, off by default:** copy the operator's real
  `<real data dir>/opencode/auth.json` into the cell's data directory at mode
  `0600`. The source path is adapter-fixed and cannot be chosen by a profile;
  the destination is a fixed cell path. The path is registered for scrubbing
  before the copy, is removed even under `--keep`, and failing to scrub is
  warned about by path only (never by value). Because that file can carry a
  rotating OAuth token pair, the same limitation as Codex's `auth.json` bridge
  applies: a mid-run refresh updates only the isolated copy, the real file stays
  stale, and the rotated copy is discarded.
- **Deferred:** `OPENCODE_AUTH_CONTENT`. Its read semantics were observed but
  not fully verified; it is not adopted until confirmed.

Note that OpenCode can run with a free default provider without any credential
(`authUsable` is not "credentials exist"), and that an auth failure surfaces as
a non-zero exit code plus a stdout `error` event, not a clean stderr message.

### 20.7 Output normalization

- Usage and cost are summed across `step_finish` events, from
  `part.tokens = {total,input,output,reasoning,cache:{read,write}}` and
  `part.cost`. `cache.read` and `cache.write` are summed too.
- Missing fields are recorded as unknown (`null`), never as zero.
- A `null` metric carries its reason in `diagnostics`, distinguishing an absent
  field from a wrong type, a non-finite value, and a negative value, with the
  line number.
- Malformed lines (JSON syntax errors, non-objects, and a `step_finish` event
  whose payload is not a well-formed `step-finish` part) are counted with line
  numbers in `diagnostics`.
- Only fixed strings reach `diagnostics`; runtime-supplied text (for example an
  `error` event's name or message) is never persisted, because it may carry an
  arbitrary secret that pattern-based redaction does not guarantee to remove.
- `model.resolved` cannot be observed from JSON output (OpenCode emits no model
  identity event), so it is `null` with `model.resolved_reason = "unobserved"`.
- The `error` event is normalized into a diagnostic; the exit code remains the
  authoritative failure signal.
- These notes go to `diagnostics` only. They are not mirrored into the
  operator-facing `warnings` channel, preserving the §6.3 distinction.
- OpenCode's per-step cost is retained as `usage.cost_usd` because v0.3's
  `CostModel` is a no-op and `trace.cost` is always null. When `CostModel` gains
  a real implementation, cost should move there and this usage key be retired.

### 20.8 Test strategy for the adapter

A deterministic fixture `opencode` CLI shim (like the existing fixture-runtime
end-to-end test) covers detection, argument construction, config
materialization, output normalization, auth failure, timeout, signal cleanup,
redaction, path validation, the file-reference guard, and unsupported-version
results. A real authenticated smoke test is run per supported auth path.

### 20.9 Accepted risks carried by this contract

- Admin-controlled OpenCode config (macOS managed preferences / managed config
  directory, Linux `/etc/opencode/`, remote `.well-known/opencode`) is read from
  outside the cell and cannot be redirected; treated as trusted (§12.1).
- The relationship between the `credential` table in `opencode.db` and
  `auth.json` is only partially mapped; the supported credential path is the
  environment allowlist.
- `--pure` / `OPENCODE_PURE` behavior was not demonstrated to differ from the
  default in an empty cell; the adapter does not rely on it.
- OAuth refresh write-through was not exercised in the spike.
