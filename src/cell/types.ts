import type { ProfileContent } from '../profile/types.js';
import type { IsolationStrategy } from '../isolation/types.js';

/**
 * A resolved profile bundled with its content digest. `content` is the
 * fully-loaded profile data (not just a name reference), because cell
 * identity must be computed over resolved content — see cell_digest below.
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
 * The fully-resolved combination of runtime, model, harness profile, and
 * task that identifies one execution cell (design doc §7: runtime × model
 * × native harness × task).
 */
export interface ResolvedCell {
  runtimeId: string;
  requestedModel: string;
  resolvedProfile: ResolvedProfileRef;
  resolvedTask: ResolvedTaskRef;
  yuureiVersion: string;
  executionOptions: Record<string, unknown>;
  /**
   * Isolation strategy the cell runs under (design doc §7.3, §9.3). Part of
   * cell identity: level0 and level1 runs have materially different
   * HOME/config semantics and must never share a cellDigest.
   */
  isolationStrategy: IsolationStrategy;
  /** sha256 digest over the canonicalized combination of the fields above. */
  cellDigest: string;
}

export interface CellIdentityInput {
  runtimeId: string;
  requestedModel: string;
  resolvedProfile: ResolvedProfileRef;
  resolvedTask: ResolvedTaskRef;
  yuureiVersion: string;
  executionOptions: Record<string, unknown>;
  isolationStrategy: IsolationStrategy;
}
