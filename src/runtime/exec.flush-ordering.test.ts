import type * as NodeFs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated in its own file because the mock below applies to every test in
// this file — it deliberately slows down every write stream execCapture
// creates so the resolve-before-flush race from #25 becomes deterministic
// instead of a timing-dependent flake (the real race window on a fast local
// disk is too small to observe reliably, as the issue itself notes).
const ARTIFICIAL_FLUSH_DELAY_MS = 250;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args);
      const realEnd = stream.end.bind(stream);
      // Delaying the call to the real end() — rather than delaying the
      // 'finish' event itself — postpones the point where Node even starts
      // finalizing the write (flushing buffers, closing the fd), so
      // `stream.writableFinished` genuinely stays false for the delay
      // window instead of just the event notification being deferred.
      stream.end = ((...endArgs: unknown[]) => {
        setTimeout(
          () => (realEnd as (...a: unknown[]) => void)(...endArgs),
          ARTIFICIAL_FLUSH_DELAY_MS,
        );
        return stream;
      }) as typeof stream.end;
      return stream;
    },
  };
});

const { execCapture } = await import('./exec.js');

describe('execCapture stdout/stderr flush ordering (regression for #25)', () => {
  let tmpDir: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yuurei-exec-flush-test-'));
    stdoutPath = join(tmpDir, 'stdout.log');
    stderrPath = join(tmpDir, 'stderr.log');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not resolve until the write streams finish, even when flushing is slow', async () => {
    const startedAt = Date.now();
    const result = await execCapture({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hi")'],
      env: process.env as Record<string, string>,
      cwd: tmpDir,
      stdoutPath,
      stderrPath,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.exitCode).toBe(0);
    // Comfortably below ARTIFICIAL_FLUSH_DELAY_MS: if execCapture resolved
    // on the child's 'close' alone (the pre-#25-fix behavior), this would
    // return almost immediately instead of waiting out the delay.
    expect(elapsedMs).toBeGreaterThanOrEqual(ARTIFICIAL_FLUSH_DELAY_MS - 50);
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('hi');
  });
});
