import { join } from 'node:path';
import { findYuureiDir } from '../config/discovery.js';
import { readTrace } from '../trace/reader.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export async function runTraceShow(cwd: string, runId: string, logger: Logger): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const runDir = join(yuureiDir, 'runs', runId);
  const trace = await readTrace(runDir).catch(() => {
    throw new YuureiError(`no trace found for run: ${runId}`, EXIT_CODES.CONFIG_ERROR);
  });

  logger.info(runId, {
    runtime: trace.runtime.id,
    exitCode: trace.execution.exit_code,
    signal: trace.execution.signal,
    durationMs: trace.execution.duration_ms,
    timedOut: trace.execution.timed_out,
  });
}
