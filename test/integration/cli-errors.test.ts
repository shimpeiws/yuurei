import { spawn } from 'node:child_process';
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

describe('CLI errors', () => {
  it('formats errors as JSON when --json is set', async () => {
    const result = await runCli(['profile', 'unknown', '--json']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      level: 'error',
      message: 'unknown profile action: unknown',
    });
  });

  it('keeps errors as plain text without --json', async () => {
    const result = await runCli(['profile', 'unknown']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('unknown profile action: unknown\n');
  });
});
