import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../cli/exit-codes.js';
import { sha256Digest } from '../util/hash.js';
import { materializeSeed, resolveSeed, toBaselineManifest } from './index.js';
import { SEED_POLICY } from './types.js';

const git = promisify(execFile);

/**
 * Git inherits repository identity from `GIT_DIR`/`GIT_INDEX_FILE`/
 * `GIT_WORK_TREE`, which a parent git hook (e.g. lefthook running this
 * suite) sets on the environment. Strip every `GIT_*`/`LEFTHOOK*` variable
 * so fixture commands address the fixture repository, never the caller's.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && !key.startsWith('LEFTHOOK'),
    ),
  );
}

/**
 * A throwaway local Git repository. Tests exercise the real git binary the
 * same way the seed does — no mocks — so index/worktree semantics are the
 * ones Git actually enforces.
 */
async function initRepo(
  files: Record<string, string | Buffer>,
  initArgs: string[] = ['init', '-q'],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yuurei-seed-repo-'));
  await git('git', initArgs, { cwd: dir, env: cleanGitEnv() });
  await git('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    env: cleanGitEnv(),
  });
  await git('git', ['config', 'user.name', 'Test'], { cwd: dir, env: cleanGitEnv() });
  await git('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env: cleanGitEnv() });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  await git('git', ['add', '-A'], { cwd: dir, env: cleanGitEnv() });
  await git('git', ['commit', '-qm', 'initial'], { cwd: dir, env: cleanGitEnv() });
  return dir;
}

/** Runs a git subcommand inside `dir`, tolerating a non-zero exit. */
async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await git('git', ['-C', dir, ...args], { env: cleanGitEnv() });
  return stdout.toString();
}

describe('resolveSeed', () => {
  let repo = '';
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  async function repoWith(files: Record<string, string | Buffer>): Promise<string> {
    repo = await initRepo(files);
    dirs.push(repo);
    return repo;
  }

  it('resolves a clean repository to a canonical manifest and whole-baseline digest', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n', 'dir/b.txt': 'beta\n' });

    const seed = await resolveSeed(dir);

    expect(seed.head).toBe((await gitIn(dir, ['rev-parse', 'HEAD'])).trim());
    expect(Object.keys(seed.files).sort()).toEqual(['a.txt', 'dir/b.txt']);
    expect(seed.files['a.txt']?.digest).toBe(sha256Digest(Buffer.from('alpha\n')));
    expect(seed.files['a.txt']?.bytes).toBe(6);
    expect(seed.fileCount).toBe(2);
    expect(seed.totalBytes).toBe(6 + 5);
    expect(seed.digest).toMatch(/^sha256:/);
    expect(seed.diagnostics).toEqual([]);
  });

  it('resolves a repository whose object format is sha256', async () => {
    const dir = await initRepo({ 'a.txt': 'alpha\n' }, ['init', '-q', '--object-format=sha256']);
    dirs.push(dir);
    expect((await gitIn(dir, ['rev-parse', '--show-object-format'])).trim()).toBe('sha256');

    const seed = await resolveSeed(dir);

    expect(Object.keys(seed.files)).toEqual(['a.txt']);
    expect(seed.files['a.txt']?.digest).toBe(sha256Digest(Buffer.from('alpha\n')));
    expect(seed.diagnostics).toEqual([]);
  });

  it('is deterministic: two resolutions of the same repository agree', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    const first = await resolveSeed(dir);
    const second = await resolveSeed(dir);
    expect(first.digest).toBe(second.digest);
  });

  it('fails when the path is not inside a Git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuurei-seed-notrepo-'));
    dirs.push(dir);
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not inside a Git repository'),
    });
  });

  it('fails when the path is a subdirectory of the repository, not its root', async () => {
    const dir = await repoWith({ 'sub/a.txt': 'x\n' });
    await expect(resolveSeed(join(dir, 'sub'))).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not the repository root'),
    });
  });

  it('fails on a repository with no commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuurei-seed-unborn-'));
    dirs.push(dir);
    await git('git', ['init', '-q'], { cwd: dir, env: cleanGitEnv() });
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('no commits'),
    });
  });

  it('fails when a tracked file has a local edit', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    await writeFile(join(dir, 'a.txt'), 'edited\n');
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not clean'),
    });
  });

  it('fails when a tracked file is deleted from the worktree', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    await rm(join(dir, 'a.txt'));
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not clean'),
    });
  });

  it('fails on a staged-but-uncommitted new file', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    await writeFile(join(dir, 'staged.txt'), 's\n');
    await gitIn(dir, ['add', 'staged.txt']);
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not clean'),
    });
  });

  it('excludes untracked and ignored files without failing', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n', '.gitignore': 'ignored.txt\n' });
    await writeFile(join(dir, 'untracked.txt'), 'u\n');
    await writeFile(join(dir, 'ignored.txt'), 'i\n');

    const seed = await resolveSeed(dir);

    expect(Object.keys(seed.files).sort()).toEqual(['.gitignore', 'a.txt']);
  });

  it('excludes tracked .yuurei/ paths by policy, with a diagnostic', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n', '.yuurei/config.yaml': 'x: 1\n' });

    const seed = await resolveSeed(dir);

    expect(Object.keys(seed.files)).toEqual(['a.txt']);
    expect(seed.diagnostics.some((d) => d.includes('excluded by policy'))).toBe(true);
  });

  it('fails on a tracked symlink', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    await symlink('a.txt', join(dir, 'link.txt'));
    await gitIn(dir, ['add', 'link.txt']);
    await gitIn(dir, ['commit', '-qm', 'add symlink']);
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('symlink'),
    });
  });

  it('keeps a tracked file whose name contains a legitimate U+FFFD', async () => {
    // U+FFFD is a valid filename character; only genuinely invalid UTF-8
    // bytes make a path unrepresentable.
    const dir = await repoWith({ 'draft\uFFFD.txt': 'x\n' });

    const seed = await resolveSeed(dir);

    expect(Object.keys(seed.files)).toEqual(['draft\uFFFD.txt']);
  });

  it.skipIf(process.platform === 'darwin')(
    'fails on a tracked path that is not valid UTF-8',
    async () => {
      // APFS rejects invalid-UTF-8 names at open(), so the fixture needs a
      // filesystem that stores raw name bytes.
      const dir = await repoWith({ 'a.txt': 'alpha\n' });
      await writeFile(
        Buffer.concat([Buffer.from(`${dir}/`, 'utf8'), Buffer.from([0x62, 0xff])]),
        'x\n',
      );
      await gitIn(dir, ['add', '-A']);
      await gitIn(dir, ['commit', '-qm', 'add raw name']);

      await expect(resolveSeed(dir)).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONFIG_ERROR,
        message: expect.stringContaining('not valid UTF-8'),
      });
    },
  );

  it('does not place a tracked filename in an error message', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    await symlink('a.txt', join(dir, 'sensitive-name.txt'));
    await gitIn(dir, ['add', 'sensitive-name.txt']);
    await gitIn(dir, ['commit', '-qm', 'add symlink']);

    const error = await resolveSeed(dir).catch((e: unknown) => e);

    expect(error).toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    expect((error as Error).message).toContain('symlink');
    expect((error as Error).message).not.toContain('sensitive-name');
  });

  it('fails on a tracked gitlink (submodule entry)', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    // A gitlink stays clean in `git status` only when a repository exists
    // at the path with the recorded HEAD — build one so the mode check is
    // what fires, not the cleanliness check.
    const sub = join(dir, 'sub');
    await mkdir(sub);
    await git('git', ['init', '-q'], { cwd: sub, env: cleanGitEnv() });
    await git('git', ['config', 'user.email', 't@t'], { cwd: sub, env: cleanGitEnv() });
    await git('git', ['config', 'user.name', 't'], { cwd: sub, env: cleanGitEnv() });
    await writeFile(join(sub, 'b.txt'), 'y\n');
    await git('git', ['add', '-A'], { cwd: sub, env: cleanGitEnv() });
    await git('git', ['commit', '-qm', 'inner'], { cwd: sub, env: cleanGitEnv() });
    const subHead = (await gitIn(sub, ['rev-parse', 'HEAD'])).trim();
    await gitIn(dir, ['update-index', '--add', '--cacheinfo', `160000,${subHead},sub`]);
    await gitIn(dir, ['commit', '-qm', 'add gitlink']);
    await expect(resolveSeed(dir)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('submodule'),
    });
  });

  it('fails closed when a file exceeds the per-file limit', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n', 'big.txt': 'x' });
    await expect(
      resolveSeed(dir, { maxFiles: 100, maxFileBytes: 3, maxTotalBytes: 1_000_000 }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('per-file limit'),
    });
  });

  it('fails closed when the seed exceeds the file-count limit', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
    await expect(
      resolveSeed(dir, { maxFiles: 1, maxFileBytes: 1_000_000, maxTotalBytes: 1_000_000 }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('limit of 1 files'),
    });
  });

  it('fails closed when the seed exceeds the total-bytes limit', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
    await expect(
      resolveSeed(dir, { maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 6 }),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('total limit'),
    });
  });

  it('keeps a tracked file literally named __proto__ as a manifest entry', async () => {
    // `{}` + bracket assignment would invoke the prototype setter and drop
    // the file from the baseline; the manifest must be a null-prototype map.
    // (An object literal cannot carry `__proto__` as an own key either, so
    // the file is committed separately rather than via `repoWith`.)
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    await writeFile(join(dir, '__proto__'), 'magic\n');
    await gitIn(dir, ['add', '__proto__']);
    await gitIn(dir, ['commit', '-qm', 'add __proto__']);

    const seed = await resolveSeed(dir);

    expect(Object.keys(seed.files).sort()).toEqual(['__proto__', 'a.txt']);
    expect(Object.hasOwn(seed.files, '__proto__')).toBe(true);
    expect(seed.files['__proto__']?.digest).toBe(sha256Digest(Buffer.from('magic\n')));

    const cell = await mkdtemp(join(tmpdir(), 'yuurei-seed-cell-'));
    dirs.push(cell);
    const materialized = await materializeSeed(seed, cell);
    expect(materialized.digest).toBe(seed.digest);
    expect(await readFile(join(cell, '__proto__'), 'utf8')).toBe('magic\n');
  });

  it('is not redirected by an inherited GIT_DIR (git hook environment)', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    const decoy = await initRepo({ 'decoy-only.txt': 'd\n' });
    dirs.push(decoy);

    const original = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(decoy, '.git');
    try {
      const seed = await resolveSeed(dir);
      expect(Object.keys(seed.files)).toEqual(['a.txt']);
      expect(seed.head).toBe((await gitIn(dir, ['rev-parse', 'HEAD'])).trim());
    } finally {
      if (original === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = original;
    }
  });

  it('does not modify the source repository', async () => {
    const dir = await repoWith({ 'a.txt': 'alpha\n' });
    const before = await gitIn(dir, ['status', '--porcelain']);
    const headBefore = (await gitIn(dir, ['rev-parse', 'HEAD'])).trim();

    await resolveSeed(dir);

    expect(await gitIn(dir, ['status', '--porcelain'])).toBe(before);
    expect((await gitIn(dir, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
  });
});

describe('materializeSeed', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function freshRepo(files: Record<string, string | Buffer>): Promise<string> {
    const dir = await initRepo(files);
    dirs.push(dir);
    return dir;
  }

  async function freshWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'yuurei-seed-cell-'));
    dirs.push(workspace);
    return workspace;
  }

  it('materializes the baseline and reports a matching materialized digest', async () => {
    const repo = await freshRepo({ 'a.txt': 'alpha\n', 'dir/b.txt': 'beta\n' });
    const seed = await resolveSeed(repo);
    const cell = await freshWorkspace();

    const materialized = await materializeSeed(seed, cell);

    expect(materialized.digest).toBe(seed.digest);
    expect(await readFile(join(cell, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(await readFile(join(cell, 'dir/b.txt'), 'utf8')).toBe('beta\n');
  });

  it('fails when a source file changed between resolution and materialization', async () => {
    const repo = await freshRepo({ 'a.txt': 'alpha\n' });
    const seed = await resolveSeed(repo);
    await writeFile(join(repo, 'a.txt'), 'tampered\n');
    const cell = await freshWorkspace();

    await expect(materializeSeed(seed, cell)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('changed between seed resolution and materialization'),
    });
  });

  it('fails rather than hanging when a tracked path became a FIFO', async () => {
    // A blocking open would wait for a writer that never exists; the
    // non-blocking read path fails the materialization instead.
    const repo = await freshRepo({ 'a.txt': 'alpha\n' });
    const seed = await resolveSeed(repo);
    await rm(join(repo, 'a.txt'));
    await git('mkfifo', [join(repo, 'a.txt')]);
    const cell = await freshWorkspace();

    await expect(materializeSeed(seed, cell)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('cannot read a tracked file'),
    });
  });

  it('fails when the workspace already contains content', async () => {
    const repo = await freshRepo({ 'a.txt': 'alpha\n' });
    const seed = await resolveSeed(repo);
    const cell = await freshWorkspace();
    await writeFile(join(cell, 'stray.txt'), 'stray\n');

    await expect(materializeSeed(seed, cell)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not empty'),
    });
  });

  it('fails on a tracked file behind a symlinked directory', async () => {
    // Commit dir/a.txt as a real file, then swap `dir` for a symlink whose
    // target holds identical bytes: git reports the tracked path deleted
    // rather than following the link, so the cleanliness check fails closed.
    const repo = await freshRepo({ 'dir/a.txt': 'alpha\n' });
    const outside = await mkdtemp(join(tmpdir(), 'yuurei-seed-outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'a.txt'), 'alpha\n');
    await rm(join(repo, 'dir'), { recursive: true });
    await symlink(outside, join(repo, 'dir'), 'dir');

    await expect(resolveSeed(repo)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('fails rather than following a symlink planted in the workspace', async () => {
    const repo = await freshRepo({ 'a.txt': 'alpha\n' });
    const seed = await resolveSeed(repo);
    const cell = await freshWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'yuurei-seed-outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'out.txt'), 'x\n');
    await symlink(outside, join(cell, 'link'), 'dir');

    await expect(materializeSeed(seed, cell)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('fails closed on an unsafe path in the manifest', async () => {
    // Git itself rejects `..` at index update, so resolution can never
    // observe one — the write-side check is the last line of defense and
    // is exercised directly with a fabricated seed.
    const repo = await freshRepo({ 'a.txt': 'alpha\n' });
    const seed = await resolveSeed(repo);
    const evil = {
      ...seed,
      files: {
        ...seed.files,
        '../escape.txt': { digest: 'sha256:x', mode: 0o644, bytes: 1 },
      },
    };
    const cell = await freshWorkspace();

    await expect(materializeSeed(evil, cell)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('unsafe path'),
    });
  });
});

describe('toBaselineManifest', () => {
  it('binds requested and materialized identities with provenance', async () => {
    const repo = await initRepo({ 'a.txt': 'alpha\n' });
    try {
      const seed = await resolveSeed(repo);
      const manifest = toBaselineManifest(seed, seed.digest) as Record<string, unknown>;
      expect(manifest['policy']).toBe(SEED_POLICY);
      expect(manifest['requested_digest']).toBe(seed.digest);
      expect(manifest['materialized_digest']).toBe(seed.digest);
      expect(manifest['source']).toBe(seed.sourceDir);
      expect(manifest['head']).toBe(seed.head);
      expect(manifest['files']).toEqual(seed.files);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
