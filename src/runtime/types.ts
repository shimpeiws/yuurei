import type { ResolvedCell } from '../cell/types.js';
import type { IsolationContext } from '../isolation/types.js';

export interface RuntimeDetection {
  installed: boolean;
  /** null = version could not be determined; never guess a fallback value. */
  version: string | null;
  executablePath: string | null;
  /** null = auth usability was not checked. */
  authUsable: boolean | null;
}

export interface PreparedRun {
  runtimeId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  isolation: IsolationContext;
  cell: ResolvedCell;
  /**
   * Absolute paths to any credential material this adapter wrote to disk
   * during prepare() (empty for adapters that only forward env vars). The
   * pipeline scrubs these unconditionally before dispose(), even under
   * `--keep` — `--keep` preserves config/logs for debugging, never credentials.
   */
  credentialFilePaths: string[];
  /**
   * The actual real credential values this adapter forwarded or wrote,
   * regardless of where they ended up (an env var, or a field inside a
   * bridged file like Codex's auth.json). The pipeline redacts each of
   * these, by exact match, from persisted stdout/stderr — reporting values
   * rather than env var *names* is deliberate: a name-based list can never
   * reach a secret embedded inside file content, only one inside `env`.
   */
  credentialValuesToRedact: string[];
}

export interface RuntimeResult {
  /** null = process was killed by signal or the exit code was never observed. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  stdoutPath: string;
  stderrPath: string;
  timedOut: boolean;
}

export interface NormalizedTraceFragment {
  runtime: { id: string; version: string | null };
  model: { requested: string; resolved: string | null };
  execution: { exitCode: number | null; durationMs: number | null };
  /** null = usage metric was not observed; never default to 0. */
  usage: Record<string, number | null>;
}

/**
 * Hides runtime-specific launch/inspect/exit handling. Implementations
 * (ClaudeCodeRuntime, CodexRuntime) must keep their config path/CLI-arg/
 * env-var conventions encapsulated internally — nothing runtime-specific
 * should leak into the core (design doc §6.1).
 */
export interface Runtime {
  id(): string;
  detect(): Promise<RuntimeDetection>;
  prepare(cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun>;
  execute(run: PreparedRun): Promise<RuntimeResult>;
  normalize(result: RuntimeResult): Promise<NormalizedTraceFragment>;
}
