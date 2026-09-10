import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function runCli(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: process.cwd(),
    env: process.env,
  });
  const chunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          code,
          stdout: Buffer.concat(chunks).toString(),
          stderr: Buffer.concat(errorChunks).toString(),
        }),
      );
    },
  );
  return result;
}

describe('CLI version', () => {
  it('reports the version from package.json', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    const result = await runCli(['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toContain(manifest.version);
  });
});
