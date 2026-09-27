import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Digest } from '../util/hash.js';
import { buildSeededPatch, collectSeededWorkspace, toChangesManifest } from './seeded.js';
import type { SeedManifest } from '../seed/types.js';

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Writes `files` under `dir`, returning a manifest entry for each. */
async function writeTree(dir: string, files: Record<string, string>): Promise<SeedManifest> {
  const manifest: SeedManifest = {};
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    manifest[path] = {
      digest: sha256Digest(Buffer.from(content)),
      mode: 0o644,
      bytes: Buffer.byteLength(content),
    };
  }
  return manifest;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('collectSeededWorkspace', () => {
  it('retains only added and modified files and reports the deletion', async () => {
    const baseline: SeedManifest = {
      'keep.txt': { digest: sha256Digest(Buffer.from('same\n')), mode: 0o644, bytes: 5 },
      'mod.txt': { digest: sha256Digest(Buffer.from('old\n')), mode: 0o644, bytes: 4 },
      'gone.txt': { digest: sha256Digest(Buffer.from('bye\n')), mode: 0o644, bytes: 4 },
    };
    const cell = await tempDir('yuurei-seeded-cell-');
    const durable = await tempDir('yuurei-seeded-durable-');
    await writeTree(cell, {
      'keep.txt': 'same\n',
      'mod.txt': 'new\n',
      'new.txt': 'added\n',
    });

    const result = await collectSeededWorkspace(cell, durable, baseline);

    expect(result.complete).toBe(true);
    expect(result.changes).toEqual({
      added: ['new.txt'],
      modified: ['mod.txt'],
      deleted: ['gone.txt'],
    });
    // Unchanged baseline content is not retained; changed/added content is.
    await expect(readFile(join(durable, 'keep.txt'))).rejects.toThrow();
    expect(await readFile(join(durable, 'mod.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(join(durable, 'new.txt'), 'utf8')).toBe('added\n');
    await expect(readFile(join(durable, 'gone.txt'))).rejects.toThrow();
  });

  it('reports a complete no-change run as an empty change set', async () => {
    const cell = await tempDir('yuurei-seeded-cell-');
    const baseline = await writeTree(cell, { 'a.txt': 'same\n' });
    const durable = await tempDir('yuurei-seeded-durable-');

    const result = await collectSeededWorkspace(cell, durable, baseline);

    expect(result.complete).toBe(true);
    expect(result.changes).toEqual({ added: [], modified: [], deleted: [] });
    expect(result.diagnostics).toEqual([]);
  });

  it('skips a symlink in the cell and counts a symlinked baseline path as deleted', async () => {
    const cell = await tempDir('yuurei-seeded-cell-');
    const baseline = await writeTree(cell, { 'a.txt': 'same\n', 'b.txt': 'same\n' });
    const outside = await tempDir('yuurei-seeded-outside-');
    await rm(join(cell, 'a.txt'));
    await rm(join(cell, 'b.txt'));
    await symlink(join(outside, 'target'), join(cell, 'a.txt'));
    await symlink(join(outside, 'target'), join(cell, 'new-link'));
    const durable = await tempDir('yuurei-seeded-durable-');

    const result = await collectSeededWorkspace(cell, durable, baseline);

    expect(result.complete).toBe(true);
    expect(result.changes.added).toEqual([]);
    expect(result.changes.deleted).toEqual(['a.txt', 'b.txt']);
    expect(result.diagnostics.some((d) => d.includes('symlink'))).toBe(true);
    await expect(readFile(join(durable, 'a.txt'))).rejects.toThrow();
  });

  it('marks collection incomplete when a cell file cannot be read', async () => {
    const cell = await tempDir('yuurei-seeded-cell-');
    const baseline = await writeTree(cell, { 'a.txt': 'same\n' });
    await writeFile(join(cell, 'new.txt'), 'added\n');
    await chmod(join(cell, 'new.txt'), 0o000);
    const durable = await tempDir('yuurei-seeded-durable-');

    try {
      const result = await collectSeededWorkspace(cell, durable, baseline);
      expect(result.complete).toBe(false);
      expect(result.diagnostics.some((d) => d.includes('may be incomplete'))).toBe(true);
    } finally {
      await chmod(join(cell, 'new.txt'), 0o644);
    }
  });
});

describe('buildSeededPatch', () => {
  async function fixture(changes: {
    add?: Record<string, string>;
    modify?: Record<string, { before: string; after: string }>;
    deleteFrom?: Record<string, string>;
  }) {
    // The source repository supplies baseline bytes; the durable workspace
    // holds only added and modified results.
    const sourceDir = await tempDir('yuurei-patch-src-');
    const workspaceDir = await tempDir('yuurei-patch-dst-');
    const baseline: SeedManifest = {};
    for (const [path, content] of Object.entries(changes.deleteFrom ?? {})) {
      await writeFile(join(sourceDir, path), content).catch(async () => {
        await mkdir(dirname(join(sourceDir, path)), { recursive: true });
        await writeFile(join(sourceDir, path), content);
      });
      baseline[path] = {
        digest: sha256Digest(Buffer.from(content)),
        mode: 0o644,
        bytes: Buffer.byteLength(content),
      };
    }
    for (const [path, { before, after }] of Object.entries(changes.modify ?? {})) {
      await mkdir(dirname(join(sourceDir, path)), { recursive: true });
      await writeFile(join(sourceDir, path), before);
      baseline[path] = {
        digest: sha256Digest(Buffer.from(before)),
        mode: 0o644,
        bytes: Buffer.byteLength(before),
      };
      await mkdir(dirname(join(workspaceDir, path)), { recursive: true });
      await writeFile(join(workspaceDir, path), after);
    }
    for (const [path, content] of Object.entries(changes.add ?? {})) {
      await mkdir(dirname(join(workspaceDir, path)), { recursive: true });
      await writeFile(join(workspaceDir, path), content);
    }
    return { sourceDir, workspaceDir, baseline };
  }

  it('renders additions, a whole-file modification, and a deletion', async () => {
    const { sourceDir, workspaceDir, baseline } = await fixture({
      add: { 'new.txt': 'hello\nworld\n' },
      modify: { 'mod.txt': { before: 'old one\nold two\n', after: 'new one\n' } },
      deleteFrom: { 'gone.txt': 'bye now\n' },
    });
    const changes = {
      added: ['new.txt'],
      modified: ['mod.txt'],
      deleted: ['gone.txt'],
    };

    const patch = await buildSeededPatch(
      changes,
      { workspaceDir, sourceDir, baseline },
      1024 * 1024,
    );

    expect(patch.diagnostics).toEqual([]);
    // Sorted by path bytes: gone.txt < mod.txt < new.txt. An added file
    // keeps the `--- /dev/null` header, so its marker is the `+++` line.
    const gone = patch.diff.indexOf('--- gone.txt');
    const mod = patch.diff.indexOf('--- mod.txt');
    const added = patch.diff.indexOf('+++ new.txt');
    expect(gone).toBeGreaterThanOrEqual(0);
    expect(mod).toBeGreaterThan(gone);
    expect(added).toBeGreaterThan(mod);
    expect(patch.diff).toContain('+++ /dev/null\n');
    expect(patch.diff).toContain('--- /dev/null\n');
    expect(patch.diff).toContain('-old one\n-old two\n');
    expect(patch.diff).toContain('+new one\n');
    expect(patch.diff).toContain('-bye now\n');
  });

  it('renders a modification from an empty file', async () => {
    const { sourceDir, workspaceDir, baseline } = await fixture({
      modify: { 'e.txt': { before: '', after: 'hello\n' } },
    });

    const patch = await buildSeededPatch(
      { added: [], modified: ['e.txt'], deleted: [] },
      { workspaceDir, sourceDir, baseline },
      1024 * 1024,
    );

    // Zero old lines: no fabricated `-` line and no no-newline marker.
    expect(patch.diff).toBe('--- e.txt\n+++ e.txt\n@@ -0,0 +1,1 @@\n+hello\n');
    expect(patch.diagnostics).toEqual([]);
  });

  it('renders a modification into an empty file', async () => {
    const { sourceDir, workspaceDir, baseline } = await fixture({
      modify: { 'e.txt': { before: 'hello\n', after: '' } },
    });

    const patch = await buildSeededPatch(
      { added: [], modified: ['e.txt'], deleted: [] },
      { workspaceDir, sourceDir, baseline },
      1024 * 1024,
    );

    expect(patch.diff).toBe('--- e.txt\n+++ e.txt\n@@ -1,1 +0,0 @@\n-hello\n');
    expect(patch.diagnostics).toEqual([]);
  });

  it('produces an empty diff for a no-change run', async () => {
    const { sourceDir, workspaceDir, baseline } = await fixture({});
    const patch = await buildSeededPatch(
      { added: [], modified: [], deleted: [] },
      { workspaceDir, sourceDir, baseline },
      1024 * 1024,
    );
    expect(patch.diff).toBe('');
    expect(patch.diagnostics).toEqual([]);
  });

  it('omits a binary change with a diagnostic', async () => {
    const cell = await tempDir('yuurei-patch-dst-');
    const sourceDir = await tempDir('yuurei-patch-src-');
    await writeFile(join(cell, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const patch = await buildSeededPatch(
      { added: ['bin.dat'], modified: [], deleted: [] },
      { workspaceDir: cell, sourceDir, baseline: {} },
      1024 * 1024,
    );
    expect(patch.diff).toBe('');
    expect(patch.diagnostics).toEqual(['patch: 1 binary file(s) omitted']);
  });

  it('omits a deleted file whose baseline bytes no longer verify', async () => {
    const sourceDir = await tempDir('yuurei-patch-src-');
    const workspaceDir = await tempDir('yuurei-patch-dst-');
    await writeFile(join(sourceDir, 'gone.txt'), 'drifted\n');
    const baseline: SeedManifest = {
      'gone.txt': {
        digest: sha256Digest(Buffer.from('original\n')),
        mode: 0o644,
        bytes: 9,
      },
    };
    const patch = await buildSeededPatch(
      { added: [], modified: [], deleted: ['gone.txt'] },
      { workspaceDir, sourceDir, baseline },
      1024 * 1024,
    );
    expect(patch.diff).toBe('');
    expect(patch.diagnostics).toEqual(['patch: 1 file(s) omitted; baseline content unavailable']);
  });
});

describe('toChangesManifest', () => {
  it('binds the change set to the baseline identity', () => {
    const manifest = toChangesManifest('sha256:base', {
      added: ['a.txt'],
      modified: ['m.txt'],
      deleted: ['d.txt'],
    });
    expect(manifest).toEqual({
      version: 1,
      baseline_digest: 'sha256:base',
      added: ['a.txt'],
      modified: ['m.txt'],
      deleted: ['d.txt'],
    });
  });
});
