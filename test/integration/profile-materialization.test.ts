import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { createVerifiedIsolation } from '../../src/isolation/index.js';
import { Level1Isolation } from '../../src/isolation/level1.js';
import { loadProfile } from '../../src/profile/loader.js';
import { ClaudeCodeRuntime } from '../../src/runtime/claude-code/index.js';
import { CodexRuntime } from '../../src/runtime/codex/index.js';
import { writeFileTree } from '../../src/util/fs.js';
import type { ResolvedCell } from '../../src/cell/types.js';
import type { ProfileContent } from '../../src/profile/types.js';

function makeCell(configFiles: Record<string, string>): ResolvedCell {
  const content: ProfileContent = { profileYaml: { runtime: 'claude-code' }, configFiles };
  return {
    runtimeId: 'claude-code',
    requestedModel: '',
    resolvedProfile: { name: 'test', content, digest: 'sha256:test' },
    resolvedTask: { source: 'task.md', content: '# Task\n', digest: 'sha256:task' },
    yuureiVersion: '0.0.1',
    executionOptions: {},
    cellDigest: 'sha256:cell',
  };
}

describe('profile materialization', () => {
  let workDir: string;
  let realHome: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-mat-test-'));
    // Override HOME so bridgeCodexCredentials doesn't read the real ~/.codex/auth.json.
    realHome = process.env['HOME'];
    process.env['HOME'] = workDir;
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = realHome;
    await rm(workDir, { recursive: true, force: true });
  });

  it('materializes profile config files into the isolated .claude directory', async () => {
    const cell = makeCell({
      'settings.json': '{"from":"profile"}\n',
      'skills/x/SKILL.md': '# x\n',
    });

    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await new ClaudeCodeRuntime().prepare(cell, context);

      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      const dest = join(homeDir, '.claude');
      expect(await readFile(join(dest, 'settings.json'), 'utf8')).toBe('{"from":"profile"}\n');
      expect(await readFile(join(dest, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('# x\n');
    } finally {
      await isolation.dispose(context);
    }
  });

  it('rejects a symlink in profile config that escapes the config directory', async () => {
    // Set up a profile directory with a symlink config/escape.md -> /etc/hosts
    const profileDir = join(workDir, 'profile');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await symlink('/etc/hosts', join(configDir, 'escape.md'));

    const profile = {
      name: 'escape-test',
      runtime: 'claude-code',
      sourceDir: profileDir,
    };

    await expect(loadProfile(profile)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('rejects a dangling symlink in profile config', async () => {
    const profileDir = join(workDir, 'profile2');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await symlink(join(configDir, 'nonexistent.txt'), join(configDir, 'dangling.md'));

    const profile = {
      name: 'dangling-test',
      runtime: 'claude-code',
      sourceDir: profileDir,
    };

    await expect(loadProfile(profile)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('bridges a real ~/.codex/auth.json into the isolated CODEX_HOME at mode 0600', async () => {
    const realCodexDir = join(workDir, '.codex');
    await mkdir(realCodexDir, { recursive: true });
    await writeFile(join(realCodexDir, 'auth.json'), '{"token":"fake"}\n', 'utf8');

    const cell: ResolvedCell = { ...makeCell({}), runtimeId: 'codex' };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      await new CodexRuntime().prepare(cell, context);

      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      const bridgedPath = join(homeDir, '.codex', 'auth.json');
      expect(await readFile(bridgedPath, 'utf8')).toBe('{"token":"fake"}\n');
      expect((await stat(bridgedPath)).mode & 0o777).toBe(0o600);
    } finally {
      await isolation.dispose(context);
    }
  });

  it('proceeds without a credential file when ~/.codex/auth.json does not exist', async () => {
    // workDir has no .codex/ at all — bridging must be a silent no-op, not a failure.
    const cell: ResolvedCell = { ...makeCell({}), runtimeId: 'codex' };
    const isolation = new Level1Isolation();
    const context = await createVerifiedIsolation(isolation, cell);
    try {
      const prepared = await new CodexRuntime().prepare(cell, context);
      expect(prepared.command).toBe('codex');

      const homeDir = context.homeDir;
      if (!homeDir) throw new Error('level1 isolation must provide homeDir');
      await expect(readFile(join(homeDir, '.codex', 'auth.json'), 'utf8')).rejects.toThrow();
    } finally {
      await isolation.dispose(context);
    }
  });

  it('writeFileTree refuses a key that escapes the destination directory', async () => {
    const destDir = join(workDir, 'dest');
    await mkdir(destDir, { recursive: true });

    await expect(writeFileTree(destDir, { '../escaped.txt': 'pwned\n' })).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
    await expect(readFile(join(workDir, 'escaped.txt'), 'utf8')).rejects.toThrow();
  });

  it('materializes two symlinks that both point at the same real subdirectory', async () => {
    // Not a cycle: aaa and zzz are siblings, neither is an ancestor of the other,
    // so both must be walked even though they resolve to the same real dir.
    const profileDir = join(workDir, 'profile3');
    const configDir = join(profileDir, 'config');
    const realDir = join(configDir, 'real');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await writeFile(join(realDir, 'f.md'), '# f\n', 'utf8');
    await symlink(realDir, join(configDir, 'aaa'));
    await symlink(realDir, join(configDir, 'zzz'));

    const profile = { name: 'siblings-test', runtime: 'claude-code', sourceDir: profileDir };
    const resolved = await loadProfile(profile);

    expect(Object.keys(resolved.content.configFiles).sort()).toEqual([
      'aaa/f.md',
      'real/f.md',
      'zzz/f.md',
    ]);
  });

  it('rejects a symlink that forms a real cycle', async () => {
    const profileDir = join(workDir, 'profile4');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: claude-code\n', 'utf8');
    await symlink(configDir, join(configDir, 'self'));

    const profile = { name: 'cycle-test', runtime: 'claude-code', sourceDir: profileDir };
    await expect(loadProfile(profile)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });
});
