import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';
import { Level0Isolation } from './level0.js';
import { Level1Isolation } from './level1.js';
import type { Isolation, IsolationContext, IsolationReport } from './types.js';

export function createIsolation(strategy: 'level0' | 'level1'): Isolation {
  return strategy === 'level0' ? new Level0Isolation() : new Level1Isolation();
}

/**
 * Fail-closed gate: throws if isolation cannot be verified. This is the
 * only place callers should call to get a verified context — never call
 * `isolation.verify()` directly and branch on the result elsewhere.
 */
export async function createVerifiedIsolation(
  isolation: Isolation,
  cell: Parameters<Isolation['create']>[0],
): Promise<IsolationContext> {
  const context = await isolation.create(cell);
  const report: IsolationReport = await isolation.verify(context);

  if (!report.verified) {
    await isolation.dispose(context);
    throw new YuureiError(
      `isolation verification failed: ${report.findings.join('; ')}`,
      EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
    );
  }

  return context;
}
