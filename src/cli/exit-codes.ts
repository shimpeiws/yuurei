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

export class YuureiError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = 'YuureiError';
  }
}
