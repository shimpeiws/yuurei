import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SIGNAL_EXIT_CODES } from '../../src/run/signals.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'signal-hang.ts');
const PREPARE_FIXTURE = join(import.meta.dirname, 'fixtures', 'signal-during-prepare.ts');

interface HangMarker {
  rootDir: string;
  runsDir: string;
}

interface PrepareMarker {
  rootDir: string;
  credentialPath: string;
  runsDir: string;
}

describe('signal cleanup', () => {
  let markerDir: string;
  /** Temp dirs to clean up even when a test assertion fails. */
  let rootDirs: string[];

  beforeEach(async () => {
    markerDir = await mkdtemp(join(tmpdir(), 'yuurei-signal-test-'));
    rootDirs = [];
  });

  afterEach(async () => {
    await rm(markerDir, { recursive: true, force: true });
    for (const dir of rootDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Spawns a fixture, waits for it to synchronously write the marker file
   * (proving the pipeline's signal handler is installed and the credential
   * file exists), then sends `signal` and returns the child's exit code and
   * the parsed marker JSON.
   */
  async function runFixtureUntilSignal(
    signal: string,
    fixture: string = FIXTURE,
  ): Promise<{ code: number | null; marker: Record<string, string> }> {
    const markerPath = join(markerDir, 'marker');
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: process.cwd(),
      env: { ...process.env, YUUREI_SIGNAL_MARKER: markerPath },
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    let parsed: Record<string, string> | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const raw = (await readFile(markerPath, 'utf8')).trim();
        if (raw) {
          parsed = JSON.parse(raw) as Record<string, string>;
          break;
        }
      } catch {
        // Marker not written yet — keep polling.
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (parsed === undefined) {
      child.kill('SIGKILL');
      throw new Error(
        `fixture never reported ready (stderr: ${Buffer.concat(stderrChunks).toString()})`,
      );
    }

    child.kill(signal);
    const code = await exited;
    return { code, marker: parsed };
  }

  it.each([
    ['SIGINT', SIGNAL_EXIT_CODES.SIGINT],
    ['SIGTERM', SIGNAL_EXIT_CODES.SIGTERM],
  ])('scrubs credentials and disposes the isolation temp dir on %s', async (signal, exitCode) => {
    const { code, marker } = await runFixtureUntilSignal(signal);
    const { rootDir, runsDir } = marker as unknown as HangMarker;
    rootDirs.push(rootDir);

    expect(code).toBe(exitCode);
    await expect(stat(rootDir)).rejects.toThrow();
    // Defect B: no partial run directory should remain after a caught signal.
    const runEntries = await readdir(runsDir).catch(() => []);
    expect(runEntries).toHaveLength(0);
  });

  // §9.2: --keep preserves config and logs for debugging, never credential
  // material. The scrub must therefore reach a credential written during
  // prepare(), which is where the real Codex auth-file bridge writes it —
  // an operator pressing Ctrl-C during run startup lands in that window.
  it.each([
    ['SIGINT', SIGNAL_EXIT_CODES.SIGINT],
    ['SIGTERM', SIGNAL_EXIT_CODES.SIGTERM],
  ])(
    'scrubs a credential written during prepare() on %s, even under --keep',
    async (signal, exitCode) => {
      const { code, marker } = await runFixtureUntilSignal(signal, PREPARE_FIXTURE);
      const { rootDir, credentialPath, runsDir } = marker as unknown as PrepareMarker;
      rootDirs.push(rootDir);

      expect(code).toBe(exitCode);
      await expect(stat(credentialPath)).rejects.toThrow();
      // Defect B: no partial run directory should remain after a caught signal.
      const runEntries = await readdir(runsDir).catch(() => []);
      expect(runEntries).toHaveLength(0);
    },
  );
});
