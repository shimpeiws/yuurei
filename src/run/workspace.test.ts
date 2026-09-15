import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPatch, copyWorkspace } from './workspace.js';

describe('copyWorkspace', () => {
  let src: string;
  let dest: string;

  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), 'yuurei-ws-src-'));
    dest = await mkdtemp(join(tmpdir(), 'yuurei-ws-dest-'));
  });

  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
  });

  it('copies regular files recursively, preserving content', async () => {
    await mkdir(join(src, 'sub'), { recursive: true });
    await writeFile(join(src, 'a.txt'), 'a', 'utf8');
    await writeFile(join(src, 'sub', 'b.txt'), 'b', 'utf8');

    const diagnostics = await copyWorkspace(src, dest);

    expect(diagnostics).toEqual([]);
    expect(await readFile(join(dest, 'a.txt'), 'utf8')).toBe('a');
    expect(await readFile(join(dest, 'sub', 'b.txt'), 'utf8')).toBe('b');
  });

  it('skips a symlink and reports it without a path', async () => {
    await writeFile(join(src, 'real.txt'), 'real', 'utf8');
    await symlink(join(src, 'real.txt'), join(src, 'link.txt'));

    const diagnostics = await copyWorkspace(src, dest);

    expect(diagnostics).toEqual(['workspace: 1 symlink(s) skipped']);
    await expect(lstat(join(dest, 'link.txt'))).rejects.toThrow();
    expect(await readFile(join(dest, 'real.txt'), 'utf8')).toBe('real');
  });
});

describe('buildPatch', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yuurei-patch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders an all-additions diff for a new file', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8');

    const { diff, diagnostics } = await buildPatch(dir, 1024 * 1024);

    expect(diagnostics).toEqual([]);
    expect(diff).toBe('--- /dev/null\n+++ a.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n');
  });

  it('represents an empty file with headers only', async () => {
    await writeFile(join(dir, 'empty.txt'), '', 'utf8');

    const { diff } = await buildPatch(dir, 1024 * 1024);

    expect(diff).toBe('--- /dev/null\n+++ empty.txt\n');
  });

  it('marks a file with no trailing newline', async () => {
    await writeFile(join(dir, 'x.txt'), 'x', 'utf8');

    const { diff } = await buildPatch(dir, 1024 * 1024);

    expect(diff).toBe(
      '--- /dev/null\n+++ x.txt\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n',
    );
  });

  it('orders files by the UTF-8 byte sequence of their path', async () => {
    await writeFile(join(dir, 'b.txt'), 'b\n', 'utf8');
    await writeFile(join(dir, 'a.txt'), 'a\n', 'utf8');

    const { diff } = await buildPatch(dir, 1024 * 1024);

    expect(diff.indexOf('+++ a.txt')).toBeLessThan(diff.indexOf('+++ b.txt'));
  });

  it('omits a binary file and counts it, without a path', async () => {
    await writeFile(join(dir, 'raw.bin'), Buffer.from([0x00, 0x01, 0x02]));

    const { diff, diagnostics } = await buildPatch(dir, 1024 * 1024);

    expect(diff).toBe('');
    expect(diagnostics).toEqual(['patch: 1 binary file(s) omitted']);
  });

  it('omits an oversized file and counts it', async () => {
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(64), 'utf8');

    const { diff, diagnostics } = await buildPatch(dir, 16);

    expect(diff).toBe('');
    expect(diagnostics).toEqual(['patch: 1 oversized file(s) omitted']);
  });

  it('omits a file whose name cannot be represented', async () => {
    await writeFile(join(dir, 'tab\tname.txt'), 'x', 'utf8');

    const { diff, diagnostics } = await buildPatch(dir, 1024 * 1024);

    expect(diff).toBe('');
    expect(diagnostics).toEqual(['patch: 1 unrepresentable name(s) omitted']);
  });

  it('stops at the total cap and counts the remainder', async () => {
    await writeFile(join(dir, 'a.txt'), 'x\n', 'utf8');
    await writeFile(join(dir, 'b.txt'), 'x\n', 'utf8');

    // One file's diff fits in 50 bytes; the second would push it past the cap.
    const { diff, diagnostics } = await buildPatch(dir, 50);

    expect(diff).toContain('+++ a.txt');
    expect(diff).not.toContain('+++ b.txt');
    expect(diagnostics).toEqual(['patch: 1 file(s) omitted over the total cap']);
  });
});
