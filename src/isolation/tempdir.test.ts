import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOrphanTempDirs, ORPHAN_TEMP_DIR_MIN_AGE_MS, removeOrphanTempDirs } from './tempdir.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE = new Date(Date.now() - 2 * ORPHAN_TEMP_DIR_MIN_AGE_MS);

describe('orphaned temp directory sweep', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-sweep-test-'));
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

  it('reports only yuurei-prefixed directories old enough to be orphans', async () => {
    const stale = await makeDir('yuurei-stale', STALE);
    await makeDir('yuurei-fresh', new Date());
    await makeDir('other-stale', STALE);

    const orphans = await findOrphanTempDirs({ root });

    expect(orphans.map((orphan) => orphan.path)).toEqual([stale]);
    expect(orphans[0].ageMs).toBeGreaterThanOrEqual(ORPHAN_TEMP_DIR_MIN_AGE_MS);
  });

  it('ignores plain files and symlinks even with the prefix', async () => {
    const stale = await makeDir('yuurei-stale', STALE);
    const file = join(root, 'yuurei-file');
    await writeFile(file, '', 'utf8');
    const link = join(root, 'yuurei-link');
    await symlink(stale, link);

    const orphans = await findOrphanTempDirs({ root });

    expect(orphans.map((orphan) => orphan.path)).toEqual([stale]);
  });

  it('honors a custom age threshold', async () => {
    await makeDir('yuurei-recent', new Date(Date.now() - 60_000));
    await makeDir('yuurei-ancient', STALE);

    const permissive = await findOrphanTempDirs({ root, olderThanMs: 1000 });
    expect(permissive).toHaveLength(2);

    const strict = await findOrphanTempDirs({ root, olderThanMs: 3 * DAY_MS });
    expect(strict).toHaveLength(0);
  });

  it('returns no orphans for an unreadable or missing root', async () => {
    expect(await findOrphanTempDirs({ root: join(root, 'does-not-exist') })).toEqual([]);
  });

  it('removes only orphans and leaves everything else alone', async () => {
    const stale = await makeDir('yuurei-stale', STALE);
    const fresh = await makeDir('yuurei-fresh', new Date());
    const unrelated = await makeDir('other-stale', STALE);

    const result = await removeOrphanTempDirs({ root });

    expect(result.removed.map((orphan) => orphan.path)).toEqual([stale]);
    expect(result.failed).toEqual([]);
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
    await expect(stat(unrelated)).resolves.toBeTruthy();
  });

  it('reports removal failures without aborting the sweep', async () => {
    const first = await makeDir('yuurei-stale', STALE);
    const second = await makeDir('yuurei-stale-2', STALE);

    await chmod(root, 0o500);
    let result;
    try {
      result = await removeOrphanTempDirs({ root });
    } finally {
      await chmod(root, 0o700);
    }

    expect(result.removed).toEqual([]);
    expect(result.failed.map((failed) => failed.path).sort()).toEqual([first, second].sort());
    expect(result.failed.every((failed) => failed.error.length > 0)).toBe(true);
  });
});
