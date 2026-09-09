import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateRunId } from './id.js';

type RunIdGenerator = () => string;

/** The `.yuurei/runs/<run-id>/` layout described in design doc §10. */
export interface RunLayout {
  runDir: string;
  workspaceDir: string;
  tracePath: string;
  resolvedProfilePath: string;
  stdoutPath: string;
  stderrPath: string;
  artifactsPath: string;
  patchPath: string;
}

function runLayout(yuureiDir: string, runId: string): RunLayout {
  const runDir = join(yuureiDir, 'runs', runId);
  return {
    runDir,
    workspaceDir: join(runDir, 'workspace'),
    tracePath: join(runDir, 'trace.json'),
    resolvedProfilePath: join(runDir, 'resolved-profile.json'),
    stdoutPath: join(runDir, 'stdout.log'),
    stderrPath: join(runDir, 'stderr.log'),
    artifactsPath: join(runDir, 'artifacts.json'),
    patchPath: join(runDir, 'patch.diff'),
  };
}

/**
 * Creates a run layout whose run id is unique: the run's directory under
 * `runs/` is claimed with an atomic `mkdir(..., { recursive: false })`.
 * When that fails with `EEXIST` because another invocation already claimed
 * the same directory, this retries with a freshly generated run id. That is
 * what prevents two concurrent `yuurei run` invocations from sharing a run
 * directory (design doc §13 "avoiding collisions across parallel
 * executions").
 */
export async function createUniqueRunLayout(
  yuureiDir: string,
  generateId: RunIdGenerator = generateRunId,
  maxAttempts = 5,
): Promise<{ runId: string; layout: RunLayout }> {
  const runsDir = join(yuureiDir, 'runs');
  await mkdir(runsDir, { recursive: true });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const runId = generateId();
    const layout = runLayout(yuureiDir, runId);
    try {
      await mkdir(layout.runDir, { recursive: false });
      await mkdir(layout.workspaceDir, { recursive: true });
      return { runId, layout };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === maxAttempts) {
        throw error;
      }
    }
  }
  throw new Error(`failed to create a unique run layout for ${yuureiDir}`);
}
