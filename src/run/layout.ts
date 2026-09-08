import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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

export async function createRunLayout(yuureiDir: string, runId: string): Promise<RunLayout> {
  const layout = runLayout(yuureiDir, runId);
  await mkdir(layout.workspaceDir, { recursive: true });
  return layout;
}
