import type { ProfileContent } from '../profile/types.js';
import type { IsolationStrategy } from '../isolation/types.js';
import type { ResolvedSeed } from '../seed/types.js';

/**
 * A resolved profile bundled with its content digest. `content` is the
 * fully-loaded profile data (not just a name reference), because cell
 * identity must be computed over resolved content — see requested_cell below.
 */
export interface ResolvedProfileRef {
  name: string;
  content: ProfileContent;
  digest: string;
}

export interface ResolvedTaskRef {
  source: string;
  content: string;
  digest: string;
}

/**
 * The execution contracts that constitute cell identity, split by owner
 * (ADR-0009). `timeout_ms` is core, named and typed; `runtime` is the
 * adapter-owned generic record (for example `{ bridge_codex_auth_file: false }`),
 * so the common schema never has to name a specific runtime.
 *
 * `runtime` is persisted verbatim to `trace.json`. Its values must be
 * identity-forming scalars only — a boolean flag or a short option. Never put
 * credential material here; secrets are never recorded in the trace (§10.2).
 */
export interface ExecutionOptions {
  timeout_ms: number | null;
  runtime: Record<string, unknown>;
}

/**
 * The seed mode and baseline identity of a requested cell (#202). Present
 * only on seeded runs: an unseeded run has no `seed` key at all, so its
 * digest stays on the version-1 input contract and remains comparable with
 * digests computed before seeding existed.
 *
 * Only the policy and the baseline's content identity participate. The seed
 * source path and the Git HEAD are provenance recorded in the trace, not
 * identity — same rule as `profile.name` and `task.source`: two checkouts
 * with identical tracked content are the same request.
 */
export interface RequestedSeedInput {
  policy: string;
  /** Whole-baseline digest over the canonical seed manifest. */
  baselineDigest: string;
}

/**
 * The requested-cell digest input set: exactly what identifies **what was
 * requested of a cell** (design doc §7.3, ADR-0011).
 *
 * `profile.name` and `task.source` are deliberately absent. They are
 * provenance recorded in the trace, not identity (ADR-0013), so renaming a
 * profile or moving a task file without changing its content must not change
 * the digest. The `yuurei` version and the runtime version are absent for the
 * same reason (ADR-0011).
 */
export interface RequestedCellInput {
  runtimeId: string;
  requestedModel: string;
  /**
   * Isolation strategy the cell runs under (design doc §7.3, §9.3). Level0 and
   * level1 runs have materially different HOME/config semantics and must never
   * share a digest.
   */
  isolationStrategy: IsolationStrategy;
  executionOptions: ExecutionOptions;
  /** Content digest of the resolved profile. */
  profileContentDigest: string;
  /** Content digest of the resolved task. */
  taskContentDigest: string;
  seed?: RequestedSeedInput;
}

/**
 * The fully-resolved combination of runtime, model, harness profile, and task
 * that identifies one execution cell (design doc §7: runtime × model × native
 * harness × task), plus the digest of that request.
 */
export interface ResolvedCell {
  runtimeId: string;
  requestedModel: string;
  resolvedProfile: ResolvedProfileRef;
  resolvedTask: ResolvedTaskRef;
  isolationStrategy: IsolationStrategy;
  executionOptions: ExecutionOptions;
  /** Observed property of the run, recorded as `yuurei_version` (ADR-0011). */
  yuureiVersion: string;
  /** sha256 digest over `RequestedCellInput` (design doc §7.3). */
  requestedCellDigest: string;
  /** The input-set identifier this digest was computed under (ADR-0009). */
  requestedCellInputsVersion: number;
  /**
   * The resolved seed for a seeded run: its canonical manifest, whole-baseline
   * digest, and provenance. Absent on empty-workspace runs.
   */
  seed?: ResolvedSeed;
  /**
   * The prepared cell's instance identity (ADR-0021): a freshly allocated,
   * opaque identifier for each prepared isolation cell. Generated at cell
   * creation time, recorded in trace.json, and passed to pfl via --cell-id.
   */
  cellId?: string;
}
