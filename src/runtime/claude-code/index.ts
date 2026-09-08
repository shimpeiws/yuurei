import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import type { ResolvedCell } from '../../cell/types.js';
import { detectViaVersionFlag } from '../detect.js';
import { execCapture } from '../exec.js';
import type {
  NormalizedTraceFragment,
  PreparedRun,
  Runtime,
  RuntimeDetection,
  RuntimeResult,
} from '../types.js';
import { buildClaudeCodeArgs } from './args.js';
import { claudeConfigDir } from './paths.js';

const RUNTIME_ID = 'claude-code';
const COMMAND = 'claude';

export class ClaudeCodeRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectViaVersionFlag(COMMAND);
  }

  async prepare(cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> {
    const env = { ...isolation.env };
    if (isolation.homeDir) {
      env['CLAUDE_CONFIG_DIR'] = claudeConfigDir(isolation.homeDir);
    }

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildClaudeCodeArgs(cell),
      env,
      cwd: isolation.rootDir,
      isolation,
      cell,
    };
  }

  async execute(run: PreparedRun): Promise<RuntimeResult> {
    return execCapture({
      command: run.command,
      args: run.args,
      env: run.env,
      cwd: run.cwd,
      stdoutPath: join(run.isolation.rootDir, 'stdout.log'),
      stderrPath: join(run.isolation.rootDir, 'stderr.log'),
    });
  }

  async normalize(result: RuntimeResult): Promise<NormalizedTraceFragment> {
    const durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();

    return {
      runtime: { id: RUNTIME_ID, version: null },
      model: { requested: '', resolved: null },
      execution: { exitCode: result.exitCode, durationMs },
      usage: {},
    };
  }
}
