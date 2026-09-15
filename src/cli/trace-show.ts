import { join } from 'node:path';
import { findYuureiDir } from '../config/discovery.js';
import { readTrace } from '../trace/reader.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

/**
 * `yuurei trace show <run-id>`.
 *
 * With `--json` the printed line carries the whole trace: every field of
 * `trace.json` sits at the top level, beside `level` and `message`, so a
 * consumer never reads the file to obtain a field (#141). Without it, a
 * human-readable summary is printed and its shape is not a promise.
 */
export async function runTraceShow(
  cwd: string,
  runId: string,
  logger: Logger,
  json: boolean,
): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const runDir = join(yuureiDir, 'runs', runId);
  const trace = await readTrace(runDir).catch(() => {
    throw new YuureiError(`no trace found for run: ${runId}`, EXIT_CODES.CONFIG_ERROR);
  });

  if (json) {
    logger.info(runId, { ...trace });
    return;
  }

  logger.info(runId, {
    runtime: trace.runtime.id,
    exitCode: trace.execution.exit_code,
    signal: trace.execution.signal,
    durationMs: trace.execution.duration_ms,
    timedOut: trace.execution.timed_out,
    // A trace written before v0.3.0 carries neither field; absence is reported
    // as null rather than filled in with a digest the trace never held.
    requestedCell: trace.requested_cell ?? null,
    yuureiVersion: trace.yuurei_version ?? null,
    ...(trace.diagnostics && trace.diagnostics.length > 0
      ? { diagnostics: trace.diagnostics }
      : {}),
  });
}
