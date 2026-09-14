import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../cli/exit-codes.js';
import { loadProfile } from './loader.js';

describe('loadProfile', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('includes profile metadata and config file contents in the resolved profile', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));
    await mkdir(join(root, 'config', 'nested'), { recursive: true });
    await writeFile(join(root, 'profile.yaml'), 'runtime: claude-code\ndescription: Test\n');
    await writeFile(join(root, 'config', 'settings.json'), '{}\n', { mode: 0o644 });
    await writeFile(join(root, 'config', 'nested', 'skill.md'), '# Skill\n', { mode: 0o644 });

    const resolved = await loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root });

    expect(resolved.content).toEqual({
      profileYaml: { runtime: 'claude-code', description: 'Test' },
      configFiles: {
        'settings.json': { content: Buffer.from('{}\n'), mode: 0o644 | 0o100000 },
        'nested/skill.md': { content: Buffer.from('# Skill\n'), mode: 0o644 | 0o100000 },
      },
    });
    expect(resolved.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes the digest when config content changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'profile.yaml'), 'runtime: claude-code\n');
    const configFile = join(root, 'config', 'settings.json');
    await writeFile(configFile, Buffer.from('{}\n'), { mode: 0o644 });
    const first = await loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root });
    await writeFile(configFile, Buffer.from('{"changed":true}\n'), { mode: 0o644 });

    const second = await loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root });

    expect(second.digest).not.toBe(first.digest);
  });

  it('reports a missing profile.yaml as a configuration error', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));

    await expect(
      loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('reports malformed profile.yaml as a configuration error', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));
    await writeFile(join(root, 'profile.yaml'), 'runtime: [\n');

    await expect(
      loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('reports a schema-invalid profile.yaml as a configuration error', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));
    await writeFile(join(root, 'profile.yaml'), 'description: no runtime\n');

    await expect(
      loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });

  it('reports an unreadable config directory as a configuration error', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));
    await writeFile(join(root, 'profile.yaml'), 'runtime: claude-code\n');
    // `config` exists but is not a directory, so the walk fails.
    await writeFile(join(root, 'config'), 'not a directory\n');

    await expect(
      loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
  });
});
