import type { ResolvedCell } from '../cell/types.js';

export type IsolationStrategy = 'level0' | 'level1';

export interface IsolationContext {
  strategy: IsolationStrategy;
  /** Absolute path to the temporary root created for this run. */
  rootDir: string;
  /** Absolute path to the fresh working directory the runtime runs in (ADR-0016). */
  workspaceDir: string;
  /** Temporary HOME directory. Set for level1, null for level0 (arg/config-root swap only). */
  homeDir: string | null;
  env: Record<string, string>;
  /** Corresponds to the `--keep` CLI flag: skip cleanup in `dispose()` for debugging. */
  keep: boolean;
}

/**
 * Discriminated union so callers cannot reach `Runtime.execute()` without
 * narrowing to `verified: true` first — see the fail-closed principle in
 * design doc §9.1 / §12.2: isolation that cannot be verified must not run.
 */
export type IsolationReport =
  | { verified: true; strategy: IsolationStrategy; checkedAt: string }
  | { verified: false; strategy: IsolationStrategy; checkedAt: string; findings: string[] };

/**
 * Builds a temporary execution environment isolated from the user's global
 * runtime configuration, verifies that isolation, and tears it down.
 */
export interface Isolation {
  create(cell: ResolvedCell): Promise<IsolationContext>;
  verify(context: IsolationContext): Promise<IsolationReport>;
  dispose(context: IsolationContext): Promise<void>;
}
