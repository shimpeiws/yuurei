import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIGNAL_EXIT_CODES } from '../../src/run/signals.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'signal-hang.ts');

describe('signal cleanup', () => {
  let markerDir: string;

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 'yuurei-signal-test-'));
  });

  afterEach(async () => {
    await rm(markerDir, { recursive: true, force: true });
  });

  /**
   * Spawns the fixture, waits for it to synchronously write the isolation
   * root dir into the marker file (proving the pipeline's signal handler is
   * installed and the credential file exists), then sends `signal` and
   * returns the child's exit code and the root dir path.
   */
  async function runFixtureUntilSignal(
    signal: string,
  ): Promise<{ code: number | null; rootDir: string }> {
    const markerPath = join(markerDir, 'marker');
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      cwd: process.cwd(),
      env: { ...process.env, YUUREI_SIGNAL_MARKER: markerPath },
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    let rootDir: string | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const marker = (await readFile(markerPath, 'utf8')).trim();
        if (marker) {
          rootDir = marker;
          break;
        }
      } catch {
        // Marker not written yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (rootDir === undefined) {
      child.kill('SIGKILL');
      throw new Error(
        `fixture never reported ready (stderr: ${Buffer.concat(stderrChunks).toString()})`,
      );
    }

    child.kill(signal);
    const code = await exited;
    return { code, rootDir };
  }

  it.each([
    ['SIGINT', SIGNAL_EXIT_CODES.SIGINT],
    ['SIGTERM', SIGNAL_EXIT_CODES.SIGTERM],
  ])('scrubs credentials and disposes the isolation temp dir on %s', async (signal, exitCode) => {
    const { code, rootDir } = await runFixtureUntilSignal(signal);

    expect(code).toBe(exitCode);
    await expect(stat(rootDir)).rejects.toThrow();

    await rm(rootDir, { recursive: true, force: true });
  });
});
