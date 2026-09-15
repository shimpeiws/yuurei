import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUniqueRunLayout } from './layout.js';

describe('createUniqueRunLayout', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yuurei-layout-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a workspace directory and returns its layout', async () => {
    const ids: string[] = [];
    const { runId, layout } = await createUniqueRunLayout(dir, () => {
      const id = `run-${ids.length}`;
      ids.push(id);
      return id;
    });

    expect(runId).toBe('run-0');
    expect(layout.runDir).toBe(join(dir, 'runs', 'run-0'));
    expect(layout.workspaceDir).toBe(join(dir, 'runs', 'run-0', 'workspace'));
  });

  it('retries with a fresh id when the workspace directory already exists', async () => {
    await mkdir(join(dir, 'runs', 'taken'), { recursive: true });

    const ids: string[] = [];
    const { runId } = await createUniqueRunLayout(dir, () => {
      const id = ids.length === 0 ? 'taken' : `fresh-${ids.length}`;
      ids.push(id);
      return id;
    });

    expect(ids).toEqual(['taken', 'fresh-1']);
    expect(runId).toBe('fresh-1');
  });

  it('gives up when every attempt collides', async () => {
    await mkdir(join(dir, 'runs', 'taken'), { recursive: true });

    await expect(createUniqueRunLayout(dir, () => 'taken', 3)).rejects.toThrow(/EEXIST/);
  });

  it('produces distinct run ids when invoked concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => createUniqueRunLayout(dir)));
    const runIds = results.map((r) => r.runId);
    expect(new Set(runIds).size).toBe(runIds.length);
  });

  it('claims the run directory atomically when two runs generate the same id', async () => {
    // Both invocations get the same first id, so the loser must see the
    // directory already claimed and retry. A non-atomic claim (e.g. mkdir with
    // `recursive: true`) would let both succeed on one directory and make the
    // run ids equal, so this test fails if the atomic `mkdir` is removed.
    let calls = 0;
    const generate = () => (calls++ < 2 ? 'same' : `fresh-${calls}`);

    const [a, b] = await Promise.all([
      createUniqueRunLayout(dir, generate),
      createUniqueRunLayout(dir, generate),
    ]);

    expect(new Set([a.runId, b.runId]).size).toBe(2);
    expect(a.layout.runDir).not.toBe(b.layout.runDir);
  });
});
