import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    await writeFile(join(root, 'config', 'settings.json'), '{}\n');
    await writeFile(join(root, 'config', 'nested', 'skill.md'), '# Skill\n');

    const resolved = await loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root });

    expect(resolved.content).toEqual({
      profileYaml: { runtime: 'claude-code', description: 'Test' },
      configFiles: { 'settings.json': '{}\n', 'nested/skill.md': '# Skill\n' },
    });
    expect(resolved.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes the digest when config content changes', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-profile-'));
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'profile.yaml'), 'runtime: claude-code\n');
    const configFile = join(root, 'config', 'settings.json');
    await writeFile(configFile, '{}\n');
    const first = await loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root });
    await writeFile(configFile, '{"changed":true}\n');

    const second = await loadProfile({ name: 'test', runtime: 'claude-code', sourceDir: root });

    expect(second.digest).not.toBe(first.digest);
  });
});
