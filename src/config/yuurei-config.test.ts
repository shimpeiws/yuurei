import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadYuureiConfig } from './yuurei-config.js';

describe('loadYuureiConfig', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('parses a valid project configuration', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-config-'));
    await writeFile(
      join(root, 'yuurei.yaml'),
      'version: 1\nprofiles:\n  default:\n    runtime: codex\n    source: profiles/default\nruns:\n  smoke:\n    profile: default\n    task: tasks/smoke.md\n',
    );

    await expect(loadYuureiConfig(root)).resolves.toEqual({
      version: 1,
      profiles: { default: { runtime: 'codex', source: 'profiles/default' } },
      runs: { smoke: { profile: 'default', task: 'tasks/smoke.md' } },
    });
  });

  it('rejects an invalid schema version', async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-config-'));
    await writeFile(join(root, 'yuurei.yaml'), 'version: 2\nprofiles: {}\nruns: {}\n');

    await expect(loadYuureiConfig(root)).rejects.toThrow();
  });
});
