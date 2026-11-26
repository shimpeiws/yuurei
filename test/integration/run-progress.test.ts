import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupFixtures,
  createFixtureProject,
  runCli,
  runIdFrom,
} from '../harness/cli-fixture.js';

/**
 * End-to-end coverage for run liveness (#258): the stderr progress line and
 * `.yuurei/runs/<run-id>/status.json`. The slow shim sleeps ~2.5s so the
 * run outlives the 1s status interval used by the tests.
 */

const SLOW_SHIM = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.0\\n');
  process.exit(0);
}
const fs = require('node:fs');
setTimeout(() => {
  fs.writeFileSync('activity-marker.txt', 'tick\\n');
}, 800);
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    result: 'slow fixture response',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, 2500);
`;

const HANGING_SHIM = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.0\\n');
  process.exit(0);
}
setTimeout(() => {}, 30000);
`;

interface StatusRecord {
  run_id: string;
  state: 'running' | 'finished' | 'timed_out' | 'interrupted';
  started_at: string;
  elapsed_s: number;
  last_activity_at: string | null;
  pid: number;
  finished_at?: string;
}

async function readStatusFile(root: string, runId: string): Promise<StatusRecord> {
  return JSON.parse(
    await readFile(join(root, '.yuurei', 'runs', runId, 'status.json'), 'utf8'),
  ) as StatusRecord;
}

/** Polls .yuurei/runs/ until the single run directory's status.json parses. */
async function pollForRunningStatus(
  root: string,
): Promise<{ runId: string; status: StatusRecord }> {
  const runsDir = join(root, '.yuurei', 'runs');
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const entries = await readdir(runsDir);
      if (entries.length === 1) {
        const status = await readStatusFile(root, entries[0] as string);
        return { runId: entries[0] as string, status };
      }
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error('status.json never appeared');
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  await cleanupFixtures();
});

describe('run progress and status.json', () => {
  it('writes status.json during the run and a final state after it', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });

    const runPromise = runCli(['run', 'smoke', '--progress=1'], project.env, project.root);
    const { runId, status: running } = await pollForRunningStatus(project.root);

    expect(running.state).toBe('running');
    expect(running.run_id).toBe(runId);
    expect(running.pid).toBeGreaterThan(0);
    expect(running.elapsed_s).toBeGreaterThanOrEqual(0);
    expect(typeof running.started_at).toBe('string');

    const result = await runPromise;
    expect(result.code).toBe(0);

    const final = await readStatusFile(project.root, runId);
    expect(final.state).toBe('finished');
    expect(final.finished_at).toBeDefined();
    expect(final.elapsed_s).toBeGreaterThanOrEqual(running.elapsed_s);
  });

  it('emits the progress line on stderr (not stdout) when forced on a non-terminal', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });
    const result = await runCli(['run', 'smoke', '--progress=1'], project.env, project.root);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/\[yuurei\] .+ running \d+s, last activity \d+s ago/);
    expect(result.stderr).toMatch(/\[yuurei\] .+ finished after \d+s/);
    // The progress feature never writes to stdout.
    expect(result.stdout).not.toContain('[yuurei]');
    expect(result.stdout).toMatch(/run .+ finished/);
  });

  it('writes no progress line by default on a non-terminal, but still writes status.json', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });
    const result = await runCli(['run', 'smoke'], project.env, project.root);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[yuurei]');
    const final = await readStatusFile(project.root, runIdFrom(result.stdout));
    expect(final.state).toBe('finished');
  });

  it('honours --no-progress while still writing status.json', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });
    const result = await runCli(['run', 'smoke', '--no-progress'], project.env, project.root);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[yuurei]');
    const final = await readStatusFile(project.root, runIdFrom(result.stdout));
    expect(final.state).toBe('finished');
  });

  it('emits progress as JSON lines on stderr with --json --progress', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });
    const result = await runCli(
      ['run', 'smoke', '--json', '--progress=1'],
      project.env,
      project.root,
    );

    expect(result.code).toBe(0);
    const progressLines = result.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(progressLines.length).toBeGreaterThanOrEqual(2);
    for (const line of progressLines) {
      const parsed = JSON.parse(line) as StatusRecord;
      expect(parsed.run_id).toBeDefined();
      expect(['running', 'finished']).toContain(parsed.state);
    }
    // stdout stays machine-readable: one JSON line for the finished run.
    expect(result.stdout).not.toContain('[yuurei]');
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
      message: expect.stringMatching(/run .+ finished/),
    });
  });

  it('records timed_out in status.json when the run exceeds --timeout', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: HANGING_SHIM,
    });
    const result = await runCli(['run', 'smoke', '--timeout', '1200'], project.env, project.root);

    // The child's SIGTERM propagates as the shell-convention exit code.
    expect(result.code).toBe(143);
    const final = await readStatusFile(project.root, runIdFrom(result.stdout));
    expect(final.state).toBe('timed_out');
  });

  it('rejects an invalid --progress interval as a configuration error', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });
    const result = await runCli(['run', 'smoke', '--progress=abc'], project.env, project.root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--progress interval');
  });

  it('rejects an invalid --progress before reading stdin for --task -', async () => {
    const project = await createFixtureProject({
      runtime: 'claude-code',
      command: 'claude',
      shim: SLOW_SHIM,
    });
    // stdin is deliberately never written: if --progress were resolved after
    // the stdin read, this child would block forever instead of exiting 2.
    const result = await runCli(
      ['run', '--profile', 'fixture', '--task', '-', '--progress=abc'],
      project.env,
      project.root,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--progress interval');
  });
});
