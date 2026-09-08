# yuurei Design Document v0.3

- **Status**: Implementation Ready
- **Updated**: 2026-09-08
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
  "schema_version": "0.1",
  "run_id": "...",
  "started_at": "...",
  "finished_at": "...",
  "runtime": {
    "id": "claude-code",
    "version": "..."
  },
  "model": {
    "requested": "...",
    "resolved": "..."
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
    "duration_ms": 0
  },
  "usage": {},
  "cost": null,
  "artifacts": []
}
```

The trace distinguishes "a value that could not be observed" from "zero." It never fills in an unknown value by guessing.

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

### 7.3 Cell identity

Each execution cell is identified by, at minimum, the following digest.

```text
cell_digest = hash(
  runtime identity,
  requested model,
  resolved profile contents,
  task contents,
  yuurei version,
  relevant execution options
)
```

The hash target is not a mere profile name, but its **resolved content**.

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

### 8.2 Exit codes

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

### 9.3 Isolation levels

v0.3's isolation is primarily at the configuration/environment level, and is not a complete security boundary against malicious code.

```text
Level 0: Swapping arguments / configuration root
Level 1: Temporary HOME with restricted environment variables
Level 2: Container or OS sandbox (Future)
Level 3: VM / remote isolation (Future)
```

The initial implementation targets Level 0–1.

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

### 10.1 What is recorded

- Execution timestamp
- `yuurei` version
- Runtime name and version
- Requested model and the observed effective model
- Digest of the profile content
- Digest of the task content
- Launch options
- Isolation strategy and its verification result
- Execution duration
- Exit code
- Observable usage
- List of artifacts and their digests

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
