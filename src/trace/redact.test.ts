import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactFile, redactKnownValues, redactSecrets } from './redact.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('redactSecrets', () => {
  it('redacts common token shapes while preserving surrounding text', () => {
    expect(redactSecrets('request sk-1234567890abcdef completed')).toBe(
      'request [REDACTED] completed',
    );
    expect(redactSecrets('Bearer abcdefghijklmnop')).toBe('[REDACTED]');
  });
});

describe('redactKnownValues', () => {
  it('redacts exact values and ignores values too short to be credentials', () => {
    expect(redactKnownValues('token=secret-value; short=abc', ['secret-value', 'abc'])).toBe(
      'token=[REDACTED]; short=abc',
    );
  });
});

describe('redactFile', () => {
  it('redacts a known value that crosses a read chunk boundary', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yuurei-redact-'));
    const inputPath = join(tempDir, 'input.log');
    const outputPath = join(tempDir, 'output.log');
    const secret = 'known-secret-crossing-the-boundary';
    const input = `${'x'.repeat(65530)}${secret} after\n`;

    await writeFile(inputPath, input, 'utf8');
    await redactFile(inputPath, outputPath, [secret], 100_000);

    const output = await readFile(outputPath, 'utf8');
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED] after');
  });
});
