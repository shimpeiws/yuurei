import { describe, expect, it } from 'vitest';
import { assertVerifiedIsolation, createVerifiedIsolation } from './index.js';
import type { Isolation, IsolationContext, IsolationReport } from './types.js';
import type { ResolvedCell } from '../cell/types.js';
import { EXIT_CODES, YuureiError } from '../cli/exit-codes.js';

/** An isolation implementation that always fails verification. */
class AlwaysFailsIsolation implements Isolation {
  disposeCalled = false;

  async create(): Promise<IsolationContext> {
    return {
      strategy: 'level0',
      rootDir: '/tmp/does-not-matter',
      workspaceDir: '/tmp/does-not-matter/workspace',
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

/** An isolation implementation that always passes verification. */
class AlwaysPassesIsolation implements Isolation {
  async create(): Promise<IsolationContext> {
    return {
      strategy: 'level1',
      rootDir: '/tmp/test-root',
      workspaceDir: '/tmp/test-root/workspace',
      homeDir: '/tmp/test-root/home',
      env: { HOME: '/tmp/test-root/home' },
      keep: false,
    };
  }

  async verify(context: IsolationContext): Promise<IsolationReport> {
    return {
      verified: true,
      strategy: context.strategy,
      checkedAt: new Date().toISOString(),
    };
  }

  async dispose(): Promise<void> {}
}

describe('createVerifiedIsolation', () => {
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

describe('assertVerifiedIsolation', () => {
  it('throws when verification fails', async () => {
    const isolation = new AlwaysFailsIsolation();
    const context = await isolation.create({} as ResolvedCell);

    await expect(assertVerifiedIsolation(isolation, context)).rejects.toThrow(
      /isolation verification failed/,
    );
    expect(isolation.disposeCalled).toBe(true);
  });

  it('succeeds when verification passes', async () => {
    const isolation = new AlwaysPassesIsolation();
    const context = await isolation.create({} as ResolvedCell);

    await expect(assertVerifiedIsolation(isolation, context)).resolves.toBeUndefined();
  });
});
