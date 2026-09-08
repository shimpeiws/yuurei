import type { ResolvedCell } from '../cell/types.js';
import { buildRestrictedEnv } from './env.js';
import { createTempDir, removeTempDir } from './tempdir.js';
import type { Isolation, IsolationContext, IsolationReport } from './types.js';
import { pathExists } from '../util/fs.js';

/**
 * Level 0 isolation: swaps CLI arguments / config-root paths only, no
 * temporary HOME. The narrowest isolation strategy (design doc §9.3).
 */
export class Level0Isolation implements Isolation {
  async create(_cell: ResolvedCell): Promise<IsolationContext> {
    const rootDir = await createTempDir();
    return {
      strategy: 'level0',
      rootDir,
      homeDir: null,
      env: buildRestrictedEnv(process.env, {}),
      keep: false,
    };
  }

  async verify(context: IsolationContext): Promise<IsolationReport> {
    const checkedAt = new Date().toISOString();
    const findings: string[] = [];

    if (!(await pathExists(context.rootDir))) {
      findings.push(`rootDir does not exist: ${context.rootDir}`);
    }
    if (context.homeDir !== null) {
      findings.push('level0 isolation must not set homeDir');
    }

    return findings.length === 0
      ? { verified: true, strategy: 'level0', checkedAt }
      : { verified: false, strategy: 'level0', checkedAt, findings };
  }

  async dispose(context: IsolationContext): Promise<void> {
    if (context.keep) return;
    await removeTempDir(context.rootDir);
  }
}
