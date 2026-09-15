import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedCell } from '../cell/types.js';
import { buildRestrictedEnv } from './env.js';
import { createTempDir, removeTempDir } from './tempdir.js';
import type { Isolation, IsolationContext, IsolationReport } from './types.js';
import { pathExists } from '../util/fs.js';

/**
 * Level 0 isolation: swaps CLI arguments / config-root paths only, no
 * temporary HOME. The narrowest isolation strategy (design doc §9.3).
 *
 * Unlike level1, the operator's real HOME is left untouched in the
 * spawned process's environment — level0 only redirects config-root
 * resolution (e.g. CLAUDE_CONFIG_DIR/CODEX_HOME, set later by the runtime
 * adapter via configRootOf()) rather than sandboxing HOME itself. A
 * runtime, hook, or command that reads $HOME for anything other than its
 * own config root still sees the operator's real home directory under
 * level0 — that is the intended, narrower tradeoff this level makes.
 */
export class Level0Isolation implements Isolation {
  async create(_cell: ResolvedCell): Promise<IsolationContext> {
    const rootDir = await createTempDir();
    const workspaceDir = join(rootDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    const realHome = process.env['HOME'];
    return {
      strategy: 'level0',
      rootDir,
      workspaceDir,
      homeDir: null,
      env: buildRestrictedEnv(process.env, realHome !== undefined ? { HOME: realHome } : {}),
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
    const realHome = process.env['HOME'];
    if (realHome !== undefined && context.env['HOME'] !== realHome) {
      findings.push('level0 isolation must leave the real HOME untouched');
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
