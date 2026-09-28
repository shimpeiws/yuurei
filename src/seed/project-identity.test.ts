import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Digest } from '../util/hash.js';
import { normalizeRemoteUrl, resolveSourceProjectIdentity } from './project-identity.js';

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

async function initRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yuurei-projid-repo-'));
  await git('git', ['init', '-q'], { cwd: dir, env: cleanGitEnv() });
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

/** The declared id the observer (pfl) derives for the same key. */
function expectedId(prefix: 'git' | 'path', key: string): string {
  return `${prefix}-${sha256Digest(key).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

describe('normalizeRemoteUrl', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'github.com/owner/repo'],
    ['https://github.com/owner/repo', 'github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'github.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['ssh://git@github.com:2222/owner/repo', 'github.com/owner/repo'],
    ['https://github.com/owner/repo/', 'github.com/owner/repo'],
    ['git@gitlab.com:group/sub/repo.git', 'gitlab.com/group/sub/repo'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  // Credentials and query parameters embedded in a remote URL must not leak
  // into the normalized string — it is recorded verbatim in the trace and in
  // the observer-facing contract file.
  it.each([
    ['https://user:pass@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://oauth2:tokensecret@gitlab.com/group/repo?x=1', 'gitlab.com/group/repo'],
    ['ssh://deploy:key@example.com/owner/repo#frag', 'example.com/owner/repo'],
    ['git@github.com:owner/repo.git?query=secret', 'github.com/owner/repo'],
    // Scheme-less userinfo (`user:pass@host/path`) is not valid scp-like
    // syntax, so it must still not reach the recorded identity.
    ['user:pass@github.com/owner/repo', 'github.com/owner/repo'],
  ])('strips credentials and query from %s', (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });
});

describe('resolveSourceProjectIdentity', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function repoWith(files: Record<string, string>): Promise<string> {
    const dir = await initRepo(files);
    dirs.push(dir);
    return dir;
  }

  it('derives a git- identity from the origin remote, stable across checkouts', async () => {
    const first = await repoWith({ 'a.txt': 'a\n' });
    const second = await repoWith({ 'b.txt': 'b\n' });
    for (const dir of [first, second]) {
      await git('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], {
        cwd: dir,
        env: cleanGitEnv(),
      });
    }

    const idFirst = await resolveSourceProjectIdentity(await realpath(first), 'head-a');
    const idSecond = await resolveSourceProjectIdentity(await realpath(second), 'head-b');

    // Two cells' worth of sources: distinct paths, same remote — one id.
    expect(idFirst.id).toBe(expectedId('git', 'github.com/acme/widget'));
    expect(idFirst.id).toBe(idSecond.id);
    expect(idFirst.kind).toBe('git-remote');
    expect(idFirst.remote).toBe('github.com/acme/widget');
    expect(idFirst.source).toBe(await realpath(first));
    expect(idFirst.head).toBe('head-a');
  });

  it('falls back to a path- identity when the repository has no remote', async () => {
    const dir = await repoWith({ 'a.txt': 'a\n' });
    const canonical = await realpath(dir);

    const identity = await resolveSourceProjectIdentity(canonical, 'head-x');

    expect(identity.id).toBe(expectedId('path', canonical));
    expect(identity.kind).toBe('local-path');
    expect(identity.remote).toBeUndefined();
    expect(identity.source).toBe(canonical);
  });

  it('gives distinct source projects distinct identities', async () => {
    const a = await repoWith({ 'a.txt': 'a\n' });
    const b = await repoWith({ 'b.txt': 'b\n' });
    await git('git', ['remote', 'add', 'origin', 'https://github.com/acme/one'], {
      cwd: a,
      env: cleanGitEnv(),
    });
    await git('git', ['remote', 'add', 'origin', 'https://github.com/acme/two'], {
      cwd: b,
      env: cleanGitEnv(),
    });

    const idA = await resolveSourceProjectIdentity(await realpath(a), 'h1');
    const idB = await resolveSourceProjectIdentity(await realpath(b), 'h2');

    expect(idA.id).not.toBe(idB.id);
    // And a remote-less project is distinct from both.
    const c = await repoWith({ 'c.txt': 'c\n' });
    const idC = await resolveSourceProjectIdentity(await realpath(c), 'h3');
    expect(idC.id).not.toBe(idA.id);
    expect(idC.id).not.toBe(idB.id);
  });

  it('prefers origin over the first configured remote', async () => {
    const dir = await repoWith({ 'a.txt': 'a\n' });
    await git('git', ['remote', 'add', 'upstream', 'https://example.com/up.git'], {
      cwd: dir,
      env: cleanGitEnv(),
    });
    await git('git', ['remote', 'add', 'origin', 'https://example.com/or.git'], {
      cwd: dir,
      env: cleanGitEnv(),
    });

    const identity = await resolveSourceProjectIdentity(await realpath(dir), 'h');

    expect(identity.id).toBe(expectedId('git', 'example.com/or'));
  });

  it('derives a local-path identity from a linked worktree, never following the gitdir pointer', async () => {
    const repo = await repoWith({ 'a.txt': 'a\n' });
    await git('git', ['remote', 'add', 'origin', 'https://example.com/acme/widget.git'], {
      cwd: repo,
      env: cleanGitEnv(),
    });
    // A linked worktree's `.git` is a file pointing at the main checkout's
    // gitdir — outside the source root. pfl refuses to follow it without
    // explicit consent, so the declared identity must fall back the same
    // way rather than claim a git-remote id the observer cannot reproduce.
    const worktreeDir = await mkdtemp(join(tmpdir(), 'yuurei-projid-wt-'));
    await rm(worktreeDir, { recursive: true, force: true });
    dirs.push(worktreeDir);
    await git('git', ['-C', repo, 'worktree', 'add', '-b', 'wt-test', worktreeDir], {
      env: cleanGitEnv(),
    });
    const canonical = await realpath(worktreeDir);

    const identity = await resolveSourceProjectIdentity(canonical, 'h-wt');

    expect(identity.kind).toBe('local-path');
    expect(identity.id).toBe(expectedId('path', canonical));
    expect(identity.remote).toBeUndefined();
  });

  it('does not pick up remote URLs from the operator global config', async () => {
    const dir = await repoWith({ 'a.txt': 'a\n' });
    const fakeHome = await mkdtemp(join(tmpdir(), 'yuurei-projid-home-'));
    dirs.push(fakeHome);
    // gitRemoteUrls inherits process.env, so the fixture HOME must be set on
    // the process for the global config to be visible at all.
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // A remote configured only in the global scope must not surface in the
      // declared identity — pfl reads the repository-local file only.
      await git('git', ['config', '--global', 'remote.origin.url', 'https://example.com/g/x.git'], {
        cwd: dir,
        env: cleanGitEnv(),
      });
      const realpathDir = await realpath(dir);
      // Sanity: an unscoped `git config` read does resolve the global remote.
      const resolved = await git(
        'git',
        ['-C', realpathDir, 'config', '--get', 'remote.origin.url'],
        { env: cleanGitEnv() },
      );
      expect(resolved.stdout.trim()).toContain('example.com');

      const identity = await resolveSourceProjectIdentity(realpathDir, 'h');
      expect(identity.kind).toBe('local-path');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('uses the first configured remote when origin is absent', async () => {
    const dir = await repoWith({ 'a.txt': 'a\n' });
    await git('git', ['remote', 'add', 'mirror', 'https://example.com/mirror.git'], {
      cwd: dir,
      env: cleanGitEnv(),
    });

    const identity = await resolveSourceProjectIdentity(await realpath(dir), 'h');

    expect(identity.id).toBe(expectedId('git', 'example.com/mirror'));
    expect(identity.kind).toBe('git-remote');
  });
});
