import type { ResolvedCell } from '../cell/types.js';
import type { IsolationContext } from '../isolation/types.js';
import type { ModelResolutionReason } from '../trace/schema.js';

export interface RuntimeDetection {
  installed: boolean;
  /** null = version could not be determined; never guess a fallback value. */
  version: string | null;
  /** null = version could not be determined; otherwise whether this version is supported. */
  versionSupported: boolean | null;
  executablePath: string | null;
  /** null = auth usability was not checked. */
  authUsable: boolean | null;
  /**
   * Safe next-step guidance for the operator when authUsable is false.
   * Only populated when installed && authUsable === false. Never contains
   * credential values, paths, or recommendations to persist tokens.
   */
  authGuidance?: string;
}

export interface PreparedRun {
  runtimeId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  isolation: IsolationContext;
  cell: ResolvedCell;
  /** null = version could not be determined at prepare() time; never a hardcoded fallback. */
  runtimeVersion: string | null;
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

/**
 * Minimal context passed from prepare() to normalize() — only the fields
 * normalize() actually needs. Keeps normalize() from depending on the full
 * PreparedRun (which includes credentials, env vars, cwd) and makes the
 * boundary explicit.
 */
export interface NormalizationContext {
  /** null = version could not be determined at prepare() time. */
  runtimeVersion: string | null;
}

export interface NormalizedTraceFragment {
  runtime: { id: string; version: string | null };
  model: {
    requested: string;
    resolved: string | null;
    /** Why `resolved` has its value; omitted when `resolved` is non-null. */
    resolvedReason?: ModelResolutionReason;
  };
  execution: { exitCode: number | null; signal: string | null; durationMs: number | null };
  /** null = usage metric was not observed; never default to 0. */
  usage: Record<string, number | null>;
  /**
   * Non-fatal issues encountered during normalization (e.g. usage parse
   * failure). Empty array and absent are equivalent — the pipeline reports
   * each entry via onWarning and does not write them to trace.json.
   */
  warnings?: string[];
  /**
   * Non-fatal notes that should be persisted into trace.json's `diagnostics`
   * (e.g. malformed runtime output). Must be secret-free by construction. The
   * pipeline copies these into the trace verbatim; empty array and absent are
   * equivalent.
   */
  diagnostics?: string[];
}

/**
 * The pipeline passes this to `prepare()` so an adapter can register each
 * credential path on disk at the moment it writes it — not when prepare()
 * returns. The scrub list is therefore populated by the write, so a signal or
 * throw between the write and the return cannot strand credential material
 * (design doc §9.2). `rm(path, { force: true })` on a never-written path is a
 * no-op, so registering before an attempted write is safe.
 */
export type RegisterCredentialPath = (path: string) => void;

/**
 * Hides runtime-specific launch/inspect/exit handling. Implementations
 * (ClaudeCodeRuntime, CodexRuntime) must keep their config path/CLI-arg/
 * env-var conventions encapsulated internally — nothing runtime-specific
 * should leak into the core (design doc §6.1).
 */
export interface Runtime {
  id(): string;
  detect(): Promise<RuntimeDetection>;
  prepare(
    cell: ResolvedCell,
    isolation: IsolationContext,
    registerCredentialPath: RegisterCredentialPath,
  ): Promise<PreparedRun>;
  /** `timeoutMs` null means no timeout is enforced. */
  execute(run: PreparedRun, timeoutMs: number | null): Promise<RuntimeResult>;
  normalize(result: RuntimeResult, context: NormalizationContext): Promise<NormalizedTraceFragment>;
}
