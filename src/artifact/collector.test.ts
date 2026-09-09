import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectArtifacts } from './collector.js';
import { sha256Digest } from '../util/hash.js';

describe('collectArtifacts', () => {
  let runDir: string | undefined;

  afterEach(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true });
  });

  it('retains an oversized artifact with capped content and metadata', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yuurei-artifacts-'));
    await writeFile(join(runDir, 'output.log'), '0123456789', 'utf8');

    await expect(collectArtifacts(runDir, ['output.log'], { maxBytes: 4 })).resolves.toEqual({
      artifacts: [
        {
          path: 'output.log',
          kind: 'log',
          digest: sha256Digest('0123'),
          truncated: true,
        },
      ],
    });
    await expect(readFile(join(runDir, 'output.log'), 'utf8')).resolves.toBe('0123');
  });

  it('preserves the mode of a rewritten executable artifact', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yuurei-artifacts-'));
    await writeFile(join(runDir, 'tool.sh'), '0123456789', { mode: 0o755 });
    await chmod(join(runDir, 'tool.sh'), 0o755);

    await expect(collectArtifacts(runDir, ['tool.sh'], { maxBytes: 4 })).resolves.toEqual({
      artifacts: [
        {
          path: 'tool.sh',
          kind: 'file',
          digest: sha256Digest('0123'),
          truncated: true,
        },
      ],
    });
    await expect(stat(join(runDir, 'tool.sh'))).resolves.toMatchObject({
      mode: 0o100755,
    });
  });

  it('preserves the existing manifest shape for normal-sized files', async () => {
    runDir = await mkdtemp(join(tmpdir(), 'yuurei-artifacts-'));
    await mkdir(join(runDir, 'nested'));
    await writeFile(join(runDir, 'nested', 'result.txt'), 'complete', 'utf8');

    await expect(
      collectArtifacts(runDir, ['nested/result.txt'], { maxBytes: 100 }),
    ).resolves.toEqual({
      artifacts: [
        {
          path: 'nested/result.txt',
          kind: 'file',
          digest: sha256Digest('complete'),
        },
      ],
    });
    await expect(readFile(join(runDir, 'nested', 'result.txt'), 'utf8')).resolves.toBe('complete');
  });
});
