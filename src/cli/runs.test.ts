import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRuns } from './runs.js';
import type { Logger } from '../util/logger.js';

interface LogLine {
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

function capturingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: string) =>
    (message: string, data?: Record<string, unknown>): void => {
      lines.push(data === undefined ? { level, message } : { level, message, data });
    };
  return { logger: { info: push('info'), warn: push('warn'), error: push('error') }, lines };
}

function trace(runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '0.3',
    run_id: runId,
    started_at: '2026-09-15T00:00:00.000Z',
    finished_at: '2026-09-15T00:00:01.000Z',
    runtime: { id: 'claude-code', version: '2.1.0' },
    model: { requested: 'sonnet', resolved: null },
    profile: { name: 'p', digest: 'sha256:p' },
    task: { source: '.yuurei/tasks/t.md', digest: 'sha256:t' },
    isolation: { strategy: 'level1', verified: true },
    execution: { exit_code: 0, signal: null, duration_ms: 1000, timed_out: false },
    usage: {},
    cost: null,
    artifacts: [],
    ...extra,
  };
}

describe('runRuns', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yuurei-runs-'));
    await mkdir(join(root, '.yuurei'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeRun(dirName: string, traceObj: Record<string, unknown>): Promise<void> {
    const dir = join(root, '.yuurei', 'runs', dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'trace.json'), JSON.stringify(traceObj), 'utf8');
  }

  it('lists valid runs in ascending run_id order with the projected fields', async () => {
    await writeRun('b-run', trace('b-run'));
    await writeRun(
      'a-run',
      trace('a-run', { requested_cell: { digest: 'sha256:c', inputs_version: 1 } }),
    );
    const { logger, lines } = capturingLogger();

    await runRuns(root, logger, true);

    const rows = lines.filter((line) => line.level === 'info').map((line) => line.data ?? {});
    expect(rows.map((row) => row['run_id'])).toEqual(['a-run', 'b-run']);
    expect(rows[0]).toEqual({
      run_id: 'a-run',
      started_at: '2026-09-15T00:00:00.000Z',
      finished_at: '2026-09-15T00:00:01.000Z',
      runtime: { id: 'claude-code' },
      model: { requested: 'sonnet' },
      profile: { name: 'p' },
      task: { source: '.yuurei/tasks/t.md' },
      isolation: { strategy: 'level1' },
      execution: { exit_code: 0, signal: null, timed_out: false },
      requested_cell: { digest: 'sha256:c', inputs_version: 1 },
    });
    // A trace without requested_cell yields a row without it, not a null.
    const second = rows[1];
    expect(second).toBeDefined();
    expect('requested_cell' in (second ?? {})).toBe(false);
    expect(second).not.toHaveProperty('runtime.version');
  });

  it('skips unreadable or inconsistent entries and warns once with the count', async () => {
    await writeRun('ok', trace('ok'));
    await mkdir(join(root, '.yuurei', 'runs', 'no-trace'), { recursive: true });
    await writeRun('mismatch', trace('other-id'));
    await writeFile(join(root, '.yuurei', 'runs', 'a-file'), 'x', 'utf8');
    const { logger, lines } = capturingLogger();

    await runRuns(root, logger, true);

    const rows = lines.filter((line) => line.level === 'info');
    expect(rows.map((line) => line.message)).toEqual(['ok']);
    const warns = lines.filter((line) => line.level === 'warn');
    expect(warns).toHaveLength(1);
    const warn = warns[0];
    expect(warn?.message).toBe('runs: 2 invalid run director(ies) skipped');
    expect(warn?.message).not.toContain('no-trace');
    expect(warn?.message).not.toContain('mismatch');
  });

  it('reports no runs when .yuurei/runs/ does not exist', async () => {
    const { logger, lines } = capturingLogger();

    await runRuns(root, logger, true);

    expect(lines).toEqual([{ level: 'info', message: 'no runs found' }]);
  });

  it('never treats a symlinked directory as a run', async () => {
    const target = await mkdtemp(join(tmpdir(), 'yuurei-runs-target-'));
    try {
      await writeFile(join(target, 'trace.json'), JSON.stringify(trace('sym')), 'utf8');
      await mkdir(join(root, '.yuurei', 'runs'), { recursive: true });
      await symlink(target, join(root, '.yuurei', 'runs', 'sym'), 'dir');
      const { logger, lines } = capturingLogger();

      await runRuns(root, logger, true);

      expect(lines).toEqual([]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('prints a human summary without the full row when --json is not set', async () => {
    await writeRun('ok', trace('ok'));
    const { logger, lines } = capturingLogger();

    await runRuns(root, logger, false);

    expect(lines).toEqual([
      {
        level: 'info',
        message: 'ok',
        data: { runtime: 'claude-code', exitCode: 0, startedAt: '2026-09-15T00:00:00.000Z' },
      },
    ]);
  });
});
