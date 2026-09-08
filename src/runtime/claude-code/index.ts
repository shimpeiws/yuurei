import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import { configRootOf } from '../../isolation/config-root.js';
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
import { writeFileTree } from '../../util/fs.js';
import { buildClaudeCodeArgs } from './args.js';
import { claudeConfigDir } from './paths.js';

const RUNTIME_ID = 'claude-code';
const COMMAND = 'claude';

// Note: also listed in trace/redact.ts's CREDENTIAL_ENV_KEYS, which the
// pipeline uses to redact known bridged values from persisted logs. Kept as
// a separate, adapter-local list here (rather than importing that one)
// because this list controls *which env vars this adapter forwards* —
// adapter-specific behavior — while the other is a cross-adapter constant
// for generic post-hoc redaction; conflating them would let a future
// third adapter's forwarding accidentally change here.
const CLAUDE_CREDENTIAL_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Approved method (design doc §9.2) for Claude Code: forward an explicitly-set
 * API key or long-lived token from the parent environment. There is no
 * credential *file* to reference — the interactive session token lives in the
 * OS keychain, which §10.2 forbids reading. Operators who authenticated via
 * subscription login run `claude setup-token` once and export the result.
 * Never reads the keychain, never copies any part of the real ~/.claude.
 */
function bridgeClaudeCredentials(env: Record<string, string>): void {
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
}

export class ClaudeCodeRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    return detectViaVersionFlag(COMMAND);
  }

  async prepare(cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> {
    const env = { ...isolation.env };
    const configDir = claudeConfigDir(configRootOf(isolation));
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFileTree(configDir, cell.resolvedProfile.content.configFiles);
    bridgeClaudeCredentials(env);
    env['CLAUDE_CONFIG_DIR'] = configDir;

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildClaudeCodeArgs(cell),
      env,
      cwd: isolation.rootDir,
      isolation,
      cell,
      // Credentials here are env vars only (bridgeClaudeCredentials above) —
      // nothing is ever written to disk, so there's nothing to scrub.
      credentialFilePaths: [],
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
