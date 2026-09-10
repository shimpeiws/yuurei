import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProfile } from '../../src/profile/loader.js';
import { writeFileTree } from '../../src/util/fs.js';

describe('issue #15: profile digest and materialization', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-issue-15-test-'));
    await chmod(workDir, 0o755);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('correctly digests non-UTF8 content (regression for digest collision)', async () => {
    const profileDir = join(workDir, 'profile');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: test\n', 'utf8');

    // Write a file with an invalid UTF-8 byte sequence (0xff)
    const file1Path = join(configDir, 'file1.dat');
    await writeFile(file1Path, Buffer.from([0xff]));

    // Write another file with a different invalid UTF-8 byte sequence (0xfe)
    const file2Path = join(configDir, 'file2.dat');
    await writeFile(file2Path, Buffer.from([0xfe]));

    const profile1 = await loadProfile({ name: 'test1', runtime: 'test', sourceDir: profileDir });
    const digest1 = profile1.digest;

    await rm(file1Path);
    await writeFile(file1Path, Buffer.from([0xfe])); // Overwrite with file2's content

    const profile2 = await loadProfile({ name: 'test2', runtime: 'test', sourceDir: profileDir });
    const digest2 = profile2.digest;

    // The digests should be different now that Buffers are correctly digested
    expect(digest1).not.toBe(digest2);
  });

  it('materializes binary content byte-for-byte and retains file modes', async () => {
    const profileDir = join(workDir, 'profile');
    const configDir = join(profileDir, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: test\n', 'utf8');

    // Create a binary file and an executable script
    const binaryContent = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const scriptContent = '#!/bin/bash\nexit 0\n';

    await writeFile(join(configDir, 'binary.bin'), binaryContent);
    await writeFile(join(configDir, 'executable.sh'), scriptContent, { mode: 0o755 });

    const loadedProfile = await loadProfile({
      name: 'test',
      runtime: 'test',
      sourceDir: profileDir,
    });

    const destDir = join(workDir, 'materialized');
    await mkdir(destDir, { recursive: true, mode: 0o755 });
    const filesToMaterialize: Record<string, { content: Buffer; mode: number }> = {};
    for (const [path, { content, mode }] of Object.entries(loadedProfile.content.configFiles)) {
      filesToMaterialize[path] = { content: Buffer.from(content as string, 'base64'), mode };
    }
    await writeFileTree(destDir, filesToMaterialize);

    // Verify binary content
    const materializedBinaryPath = join(destDir, 'binary.bin');
    expect(await readFile(materializedBinaryPath)).toEqual(binaryContent);

    // Verify executable mode
    const materializedScriptPath = join(destDir, 'executable.sh');
    expect((await stat(materializedScriptPath)).mode & 0o777).toBe(0o755);
    expect(await readFile(materializedScriptPath, 'utf8')).toBe(scriptContent);
  });

  it('handles regular UTF8 config files and symlinks as before', async () => {
    const profileDir = join(workDir, 'profile');
    const configDir = join(profileDir, 'config');
    const realDir = join(configDir, 'real');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(profileDir, 'profile.yaml'), 'runtime: test\n', 'utf8');
    await writeFile(join(realDir, 'f.md'), '# f\n', 'utf8');
    await writeFile(join(configDir, 'settings.json'), '{"key":"value"}\n', 'utf8');
    await symlink(realDir, join(configDir, 'symlinked-real'));

    const loadedProfile = await loadProfile({
      name: 'test',
      runtime: 'test',
      sourceDir: profileDir,
    });
    const configFiles = loadedProfile.content.configFiles;

    // Check content and mode for a regular UTF8 file
    expect(
      Buffer.from(configFiles['settings.json'].content as string, 'base64').toString('utf8'),
    ).toBe('{"key":"value"}\n');
    expect(configFiles['settings.json'].mode & 0o777).toBe(0o644); // Default mode

    // Check content and mode for a symlinked file
    expect(
      Buffer.from(configFiles['symlinked-real/f.md'].content as string, 'base64').toString('utf8'),
    ).toBe('# f\n');
    expect(configFiles['symlinked-real/f.md'].mode & 0o777).toBe(0o644); // Default mode

    // Check content and mode for a file in a real directory
    expect(Buffer.from(configFiles['real/f.md'].content as string, 'base64').toString('utf8')).toBe(
      '# f\n',
    );
    expect(configFiles['real/f.md'].mode & 0o777).toBe(0o644); // Default mode
  });
});
