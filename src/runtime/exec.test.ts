import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCapture, MAX_TIMEOUT_MS } from './exec.js';

describe('execCapture', () => {
  let tmpDir: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yuurei-exec-test-'));
    stdoutPath = join(tmpDir, 'stdout.log');
    stderrPath = join(tmpDir, 'stderr.log');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves with the exit code when the process exits before any timeout', async () => {
    const result = await execCapture({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hi"); process.exit(0)'],
      env: process.env as Record<string, string>,
      cwd: tmpDir,
      stdoutPath,
      stderrPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('hi');
  });

  it('sends SIGTERM and marks timedOut when timeoutMs elapses', async () => {
    const result = await execCapture({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'], // hangs; no SIGTERM handler installed
      env: process.env as Record<string, string>,
      cwd: tmpDir,
      stdoutPath,
      stderrPath,
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    // Generous margins: the child needs real wall-clock time to boot Node
    // and register its SIGTERM handler before timeoutMs fires, or it would
    // die to the default SIGTERM action instead of exercising escalation
    // (flaky on a slow/loaded CI runner with tight margins).
    const result = await execCapture({
      command: process.execPath,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      env: process.env as Record<string, string>,
      cwd: tmpDir,
      stdoutPath,
      stderrPath,
      timeoutMs: 1000,
      killGracePeriodMsForTests: 1000,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.exitCode).toBeNull();
  }, 20_000);

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['beyond MAX_TIMEOUT_MS', MAX_TIMEOUT_MS + 1],
  ])('rejects an out-of-range timeoutMs (%s)', async (_label, timeoutMs) => {
    await expect(
      execCapture({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: process.env as Record<string, string>,
        cwd: tmpDir,
        stdoutPath,
        stderrPath,
        timeoutMs,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('waits for the stdout write stream to fully flush before resolving (regression for #25)', async () => {
    // A large single write forces the destination file stream to queue
    // multiple internal flushes to disk; the child's own 'close' can land
    // before all of them land. If execCapture resolved on 'close' alone
    // (rather than also awaiting the write stream's 'finish'), the file
    // read right after resolution could come back short of `size` bytes.
    // No explicit process.exit(): calling it right after a large write to a
    // piped stdout is a known way to truncate output at the *source* (the
    // write is asynchronous and exit() doesn't wait for it) — a separate,
    // unrelated footgun this test must avoid to isolate the destination-side
    // race this regression test targets. Letting the process exit naturally
    // once the write completes keeps the child's own output complete.
    const size = 20 * 1024 * 1024;
    const result = await execCapture({
      command: process.execPath,
      args: ['-e', `process.stdout.write('x'.repeat(${size}))`],
      env: process.env as Record<string, string>,
      cwd: tmpDir,
      stdoutPath,
      stderrPath,
    });

    expect(result.exitCode).toBe(0);
    const stdoutStat = await stat(stdoutPath);
    expect(stdoutStat.size).toBe(size);
  });

  it('rejects and cleans up when the command cannot be spawned', async () => {
    await expect(
      execCapture({
        command: join(tmpDir, 'definitely-not-a-real-command'),
        args: [],
        env: process.env as Record<string, string>,
        cwd: tmpDir,
        stdoutPath,
        stderrPath,
      }),
    ).rejects.toThrow();
  });
});
