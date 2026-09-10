import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClean } from '../../src/cli/clean.js';
import { ORPHAN_TEMP_DIR_MIN_AGE_MS } from '../../src/isolation/tempdir.js';
import type { Logger } from '../../src/util/logger.js';

describe('yuurei clean', () => {
  let root: string;
  let messages: { level: string; message: string }[];

  const logger: Logger = {
    info: (message) => messages.push({ level: 'info', message }),
    warn: (message) => messages.push({ level: 'warn', message }),
    error: (message) => messages.push({ level: 'error', message }),
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-clean-test-'));
    messages = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeDir(name: string, mtime: Date): Promise<string> {
    const path = join(root, name);
    await mkdir(path);
    await utimes(path, mtime, mtime);
    return path;
  }

  it('removes only orphaned yuurei-* directories and reports the sweep', async () => {
    const stale = await makeDir(
      'yuurei-stale',
      new Date(Date.now() - 2 * ORPHAN_TEMP_DIR_MIN_AGE_MS),
    );
    const fresh = await makeDir('yuurei-fresh', new Date());
    const unrelated = await makeDir(
      'other-stale',
      new Date(Date.now() - 2 * ORPHAN_TEMP_DIR_MIN_AGE_MS),
    );

    const result = await runClean(logger, { tempDir: root });

    expect(result.removed.map((orphan) => orphan.path)).toEqual([stale]);
    expect(result.failed).toEqual([]);
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
    await expect(stat(unrelated)).resolves.toBeTruthy();
    expect(messages).toContainEqual({
      level: 'info',
      message: 'removed 1 orphaned isolation temp directory',
    });
  });

  it('reports when there is nothing to clean', async () => {
    const result = await runClean(logger, { tempDir: root });

    expect(result.removed).toEqual([]);
    expect(messages).toContainEqual({
      level: 'info',
      message: 'no orphaned isolation temp directories found',
    });
  });
});
