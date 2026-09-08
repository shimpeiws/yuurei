import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findYuureiDir } from './discovery.js';

describe('findYuureiDir', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('finds the nearest ancestor .yuurei directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-discovery-'));
    const nested = join(root, 'a', 'b');
    await mkdir(join(root, '.yuurei'), { recursive: true });
    await mkdir(nested, { recursive: true });

    expect(await findYuureiDir(nested)).toBe(join(root, '.yuurei'));
  });

  it('returns null when no ancestor contains .yuurei', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-discovery-'));
    expect(await findYuureiDir(root)).toBeNull();
  });
});
