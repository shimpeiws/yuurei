import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedCell } from '../cell/types.js';
import { isPathWithin, pathExists } from '../util/fs.js';
import { buildRestrictedEnv } from './env.js';
import { createTempDir, removeTempDir } from './tempdir.js';
import type { Isolation, IsolationContext, IsolationReport } from './types.js';

/**
 * Level 1 isolation: temporary HOME directory plus a restricted env var
 * set, so runtime adapters that read `$HOME`-relative config never touch
 * the user's real global configuration (design doc §9.3).
 */
export class Level1Isolation implements Isolation {
  async create(_cell: ResolvedCell): Promise<IsolationContext> {
    const rootDir = await createTempDir();
    const homeDir = join(rootDir, 'home');
    await mkdir(homeDir, { recursive: true, mode: 0o700 });

    return {
      strategy: 'level1',
      rootDir,
      homeDir,
      env: buildRestrictedEnv(process.env, { HOME: homeDir }),
      keep: false,
    };
  }

  async verify(context: IsolationContext): Promise<IsolationReport> {
    const checkedAt = new Date().toISOString();
    const findings: string[] = [];

    if (context.homeDir === null) {
      findings.push('level1 isolation requires a homeDir');
    } else {
      if (!(await pathExists(context.homeDir))) {
        findings.push(`homeDir does not exist: ${context.homeDir}`);
      }
      if (!(await isPathWithin(context.rootDir, context.homeDir))) {
        findings.push(`homeDir ${context.homeDir} is not nested under rootDir ${context.rootDir}`);
      }
      const realHome = process.env['HOME']
        ? await realpath(process.env['HOME']).catch(() => null)
        : null;
      const realIsolatedHome = await realpath(context.homeDir).catch(() => null);
      if (realHome !== null && realIsolatedHome === realHome) {
        findings.push('isolated homeDir resolves to the real user HOME');
      }
    }
    if (context.env['HOME'] !== context.homeDir) {
      findings.push('env.HOME does not match the isolated homeDir');
    }

    return findings.length === 0
      ? { verified: true, strategy: 'level1', checkedAt }
      : { verified: false, strategy: 'level1', checkedAt, findings };
  }

  async dispose(context: IsolationContext): Promise<void> {
    if (context.keep) return;
    await removeTempDir(context.rootDir);
  }
}
