import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findYuureiDir } from '../config/discovery.js';
import { readTrace } from '../trace/reader.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import type { Trace } from '../trace/schema.js';
import type { Logger } from '../util/logger.js';

/**
 * One row of `yuurei runs`. A fixed projection of the trace (ADR-0015): the
 * listed fields only, with the trace's own nesting, and an absent optional
 * field absent rather than `null`.
 */
export interface RunsRow {
  run_id: string;
  started_at: string;
  finished_at: string;
  runtime: { id: string };
  model: { requested: string };
  profile: { name: string };
  task: { source: string };
  isolation: { strategy: string };
  execution: { exit_code: number | null; signal: string | null; timed_out: boolean };
  requested_cell?: { digest: string; inputs_version: number };
}

function projectRow(trace: Trace): RunsRow {
  const row: RunsRow = {
    run_id: trace.run_id,
    started_at: trace.started_at,
    finished_at: trace.finished_at,
    runtime: { id: trace.runtime.id },
    model: { requested: trace.model.requested },
    profile: { name: trace.profile.name },
    task: { source: trace.task.source },
    isolation: { strategy: trace.isolation.strategy },
    execution: {
      exit_code: trace.execution.exit_code,
      signal: trace.execution.signal,
      timed_out: trace.execution.timed_out,
    },
  };
  if (trace.requested_cell !== undefined) row.requested_cell = trace.requested_cell;
  return row;
}

/**
 * `yuurei runs` — enumerate the runs under `.yuurei/runs/` (ADR-0015). A
 * directory whose trace is missing, does not parse, or whose name disagrees
 * with `trace.run_id` is skipped; the number skipped is reported as one fixed
 * warning that carries no path.
 */
export async function runRuns(cwd: string, logger: Logger, json: boolean): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const runsDir = join(yuureiDir, 'runs');
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info('no runs found');
      return;
    }
    throw new YuureiError(
      `cannot read ${runsDir}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  const rows: RunsRow[] = [];
  let skipped = 0;
  for (const entry of entries) {
    // `isDirectory()` is false for a symlink, so only real directories are read.
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    try {
      const trace = await readTrace(join(runsDir, runId));
      if (trace.run_id !== runId) {
        skipped += 1;
        continue;
      }
      rows.push(projectRow(trace));
    } catch {
      skipped += 1;
    }
  }

  rows.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));

  for (const row of rows) {
    if (json) {
      logger.info(row.run_id, { ...row });
    } else {
      logger.info(row.run_id, {
        runtime: row.runtime.id,
        exitCode: row.execution.exit_code,
        startedAt: row.started_at,
      });
    }
  }

  if (skipped > 0) {
    logger.warn(`runs: ${skipped} invalid run director(ies) skipped`);
  }
}
