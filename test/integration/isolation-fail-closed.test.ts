import { describe, expect, it } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { createVerifiedIsolation } from '../../src/isolation/index.js';
import type { Isolation, IsolationContext, IsolationReport } from '../../src/isolation/types.js';
import type { ResolvedCell } from '../../src/cell/types.js';

/** An isolation implementation that always fails verification. */
class AlwaysFailsIsolation implements Isolation {
  disposeCalled = false;

  async create(): Promise<IsolationContext> {
    return {
      strategy: 'level0',
      rootDir: '/tmp/does-not-matter',
      homeDir: null,
      env: {},
      keep: false,
    };
  }

  async verify(context: IsolationContext): Promise<IsolationReport> {
    return {
      verified: false,
      strategy: context.strategy,
      checkedAt: new Date().toISOString(),
      findings: ['deliberately unverifiable, for the fail-closed test'],
    };
  }

  async dispose(): Promise<void> {
    this.disposeCalled = true;
  }
}

describe('fail-closed isolation gate', () => {
  it('throws instead of returning a context when verification fails', async () => {
    const isolation = new AlwaysFailsIsolation();
    const created = createVerifiedIsolation(isolation, {} as ResolvedCell);

    await expect(created).rejects.toThrow(/isolation verification failed/);
    await expect(created).rejects.toMatchObject({
      exitCode: EXIT_CODES.ISOLATION_VERIFICATION_FAILED,
    });
    await expect(created).rejects.toBeInstanceOf(YuureiError);
    expect(isolation.disposeCalled).toBe(true);
  });
});
