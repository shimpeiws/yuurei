import { describe, expect, it } from 'vitest';
import { ERROR_CODES, EXIT_CODES, YuureiError } from './exit-codes.js';

/**
 * The runtime, isolation, save, and unexpected-failure categories are not
 * reachable deterministically from the CLI, so pin their default code here:
 * the exit code alone names the category, and a throw site only refines it.
 */
describe('stable error codes', () => {
  it('maps each exit code to its category code when none is given', () => {
    expect(new YuureiError('x', EXIT_CODES.CONFIG_ERROR).code).toBe(ERROR_CODES.INVALID_CONFIG);
    expect(new YuureiError('x', EXIT_CODES.RUNTIME_UNSUPPORTED).code).toBe(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
    );
    expect(new YuureiError('x', EXIT_CODES.ISOLATION_VERIFICATION_FAILED).code).toBe(
      ERROR_CODES.ISOLATION_FAILED,
    );
    expect(new YuureiError('x', EXIT_CODES.RUNTIME_EXECUTION_FAILED).code).toBe(
      ERROR_CODES.INTERNAL_ERROR,
    );
    expect(new YuureiError('x', EXIT_CODES.TRACE_OR_ARTIFACT_SAVE_FAILED).code).toBe(
      ERROR_CODES.SAVE_FAILED,
    );
  });

  it('lets a throw site refine the code without changing the exit code', () => {
    const error = new YuureiError('x', EXIT_CODES.CONFIG_ERROR, ERROR_CODES.NO_PROJECT);
    expect(error.code).toBe(ERROR_CODES.NO_PROJECT);
    expect(error.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
  });
});
