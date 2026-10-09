/** Exit codes from design doc §8.1. */
export const EXIT_CODES = {
  SUCCESS: 0,
  CONFIG_ERROR: 2,
  RUNTIME_UNSUPPORTED: 3,
  ISOLATION_VERIFICATION_FAILED: 4,
  RUNTIME_EXECUTION_FAILED: 5,
  TRACE_OR_ARTIFACT_SAVE_FAILED: 6,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Stable machine-readable error codes (contract Section A, `--json` errors).
 *
 * The `code`, not the prose `message`, is the contract: an agent branches on
 * it to decide retry / fix config / authenticate / give up, and the message
 * stays free to change. Adding a code is additive; changing or removing one
 * is a breaking change. Each code names a distinct failure an agent must be
 * able to tell apart without reading `message`, so the initial vocabulary is
 * deliberately small.
 */
export const ERROR_CODES = {
  /** No `.yuurei/` directory was found from the working directory. */
  NO_PROJECT: 'no_project',
  /** The named run is not defined in `yuurei.yaml`. */
  UNKNOWN_RUN: 'unknown_run',
  /** The named profile is not defined in `yuurei.yaml`. */
  UNKNOWN_PROFILE: 'unknown_profile',
  /** A runtime id is not one of the supported adapters. */
  UNKNOWN_RUNTIME: 'unknown_runtime',
  /** A supported runtime is not installed or is below its minimum version. */
  RUNTIME_UNAVAILABLE: 'runtime_unavailable',
  /** A configuration file or profile is unreadable, malformed, or unsafe. */
  INVALID_CONFIG: 'invalid_config',
  /** A CLI argument or run parameter has an invalid value. */
  INVALID_INPUT: 'invalid_input',
  /** A named run's task path would escape the `.yuurei/` directory. */
  TASK_PATH_ESCAPES: 'task_path_escapes',
  /** No trace exists for the requested run id. */
  NO_TRACE: 'no_trace',
  /** Isolation verification failed (fail closed). */
  ISOLATION_FAILED: 'isolation_failed',
  /** A required run output could not be saved. */
  SAVE_FAILED: 'save_failed',
  /** An unexpected failure with no more specific code. */
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The fallback code for an error that carries none of its own: the exit code
 * already names the coarse category, and a throw site only refines it when the
 * failure is one an agent must distinguish. `SUCCESS` never carries an error,
 * so its entry is unreachable and only keeps the map total.
 */
const DEFAULT_ERROR_CODE: Readonly<Record<ExitCode, ErrorCode>> = {
  [EXIT_CODES.SUCCESS]: ERROR_CODES.INTERNAL_ERROR,
  [EXIT_CODES.CONFIG_ERROR]: ERROR_CODES.INVALID_CONFIG,
  [EXIT_CODES.RUNTIME_UNSUPPORTED]: ERROR_CODES.RUNTIME_UNAVAILABLE,
  [EXIT_CODES.ISOLATION_VERIFICATION_FAILED]: ERROR_CODES.ISOLATION_FAILED,
  [EXIT_CODES.RUNTIME_EXECUTION_FAILED]: ERROR_CODES.INTERNAL_ERROR,
  [EXIT_CODES.TRACE_OR_ARTIFACT_SAVE_FAILED]: ERROR_CODES.SAVE_FAILED,
};

export class YuureiError extends Error {
  /** Stable machine-readable code (contract Section A). */
  readonly code: ErrorCode;

  constructor(
    message: string,
    public readonly exitCode: ExitCode,
    code?: ErrorCode,
  ) {
    super(message);
    this.name = 'YuureiError';
    this.code = code ?? DEFAULT_ERROR_CODE[exitCode];
  }
}
