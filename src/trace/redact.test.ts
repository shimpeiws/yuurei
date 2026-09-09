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

  it('redacts a known value longer than a read chunk across chunk boundaries', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yuurei-redact-'));
    const inputPath = join(tempDir, 'input.log');
    const outputPath = join(tempDir, 'output.log');
    const secret = `s-${'x'.repeat(100_000)}`;

    await writeFile(
      inputPath,
      `${'y'.repeat(60_000)}${secret}${'z'.repeat(64)} trailing\n`,
      'utf8',
    );

    await redactFile(inputPath, outputPath, [secret], 200_000);

    const output = await readFile(outputPath, 'utf8');
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });

  it('does not retain an unbounded generic candidate while reading multiple chunks', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yuurei-redact-'));
    const inputPath = join(tempDir, 'input.log');
    const outputPath = join(tempDir, 'output.log');
    await writeFile(inputPath, `token:${'x'.repeat(20_000)}\nfinished\n`, 'utf8');

    await redactFile(inputPath, outputPath, [], 100_000);

    const output = await readFile(outputPath, 'utf8');
    expect(output).toBe('[REDACTED]\nfinished\n');
  });

  it('keeps memory bounded by the byte cap for a huge generic candidate', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yuurei-redact-'));
    const inputPath = join(tempDir, 'input.log');
    const outputPath = join(tempDir, 'output.log');
    await writeFile(inputPath, `token:${'x'.repeat(200_000)}tail\n`, 'utf8');

    const truncated = await redactFile(inputPath, outputPath, [], 1024);

    const output = await readFile(outputPath, 'utf8');
    expect(truncated).toBe(true);
    expect(output).toBe(`[REDACTED]`);
  });

  it('redacts a known value cut short by the byte cap', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yuurei-redact-'));
    const inputPath = join(tempDir, 'input.log');
    const outputPath = join(tempDir, 'output.log');
    const secret = `s-${'x'.repeat(100_000)}`;
    await writeFile(inputPath, `${secret}${'w'.repeat(200_000)}`, 'utf8');

    const truncated = await redactFile(inputPath, outputPath, [secret], 64);

    const output = await readFile(outputPath, 'utf8');
    expect(truncated).toBe(true);
    expect(output).toBe('[REDACTED]');
  });

  it('keeps a multibyte character within the byte cap', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'yuurei-redact-'));
    const inputPath = join(tempDir, 'input.log');
    const outputPath = join(tempDir, 'output.log');
    await writeFile(inputPath, 'éclair', 'utf8');

    await redactFile(inputPath, outputPath, [], 1);

    expect(await readFile(outputPath, 'utf8')).toBe('');
  });
});
