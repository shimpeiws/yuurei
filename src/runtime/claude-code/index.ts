import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsolationContext } from '../../isolation/types.js';
import { configRootOf } from '../../isolation/config-root.js';
import type { ResolvedCell } from '../../cell/types.js';
import { detectViaVersionFlag, isVersionAtLeast } from '../detect.js';
import { execCapture } from '../exec.js';
import type {
  NormalizationContext,
  NormalizedTraceFragment,
  PreparedRun,
  Runtime,
  RuntimeDetection,
  RuntimeResult,
} from '../types.js';
import { writeFileTree } from '../../util/fs.js';
import { assertNoReservedConfigPath } from '../reserved-paths.js';
import { buildClaudeCodeArgs } from './args.js';
import { claudeConfigDir } from './paths.js';

const RUNTIME_ID = 'claude-code';
const COMMAND = 'claude';
const MIN_SUPPORTED_VERSION: [number, number, number] = [2, 0, 0];

/**
 * Claude Code resolves its credential store to `<config dir>/.credentials.json`
 * (verified against 2.1.267: a token planted there is read, parsed and sent to
 * the API). Unlike Codex there is no bridged credential *file* of yuurei's own
 * to protect -- the reservation exists because the isolated run holds no
 * credential at all under subscription login, so a profile-supplied one would
 * be used unconditionally.
 */
const CLAUDE_RESERVED_CONFIG_PATHS = ['.credentials.json'] as const;

const CLAUDE_CREDENTIAL_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Approved method (design doc §9.2) for Claude Code: forward an explicitly-set
 * API key or long-lived token from the parent environment. There is no
 * credential *file* to reference — the interactive session token lives in the
 * OS keychain, which §10.2 forbids reading. Operators who authenticated via
 * subscription login run `claude setup-token` once and export the result.
 * Never reads the keychain, never copies any part of the real ~/.claude.
 * Returns the values actually forwarded, so the pipeline can redact them
 * from persisted logs without needing to know their env var names.
 */
function bridgeClaudeCredentials(env: Record<string, string>): string[] {
  const forwardedValues: string[] = [];
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
      forwardedValues.push(value);
    }
  }
  return forwardedValues;
}

export class ClaudeCodeRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    const detection = await detectViaVersionFlag(COMMAND);
    return {
      ...detection,
      versionSupported: isVersionAtLeast(detection.version, MIN_SUPPORTED_VERSION),
      authUsable:
        detection.installed && CLAUDE_CREDENTIAL_ENV_KEYS.some((key) => Boolean(process.env[key])),
    };
  }

  async prepare(cell: ResolvedCell, isolation: IsolationContext): Promise<PreparedRun> {
    const env = { ...isolation.env };
    const configDir = claudeConfigDir(configRootOf(isolation));
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    // Reject before anything is written, rather than relying on write order to
    // paper over the collision (§9.2). Claude Code resolves its credential
    // store from CLAUDE_CONFIG_DIR, which is exactly the directory the profile
    // is materialized into.
    assertNoReservedConfigPath(
      configDir,
      cell.resolvedProfile.content.configFiles,
      CLAUDE_RESERVED_CONFIG_PATHS,
    );
    await writeFileTree(configDir, cell.resolvedProfile.content.configFiles);
    const credentialValuesToRedact = bridgeClaudeCredentials(env);
    env['CLAUDE_CONFIG_DIR'] = configDir;

    const detection = await this.detect();

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildClaudeCodeArgs(cell),
      env,
      cwd: isolation.rootDir,
      isolation,
      cell,
      runtimeVersion: detection.version,
      // Credentials here are env vars only (bridgeClaudeCredentials above) —
      // nothing is ever written to disk, so there's nothing to scrub.
      credentialFilePaths: [],
      credentialValuesToRedact,
    };
  }

  async execute(run: PreparedRun, timeoutMs: number | null): Promise<RuntimeResult> {
    return execCapture({
      command: run.command,
      args: run.args,
      env: run.env,
      cwd: run.cwd,
      stdoutPath: join(run.isolation.rootDir, 'stdout.log'),
      stderrPath: join(run.isolation.rootDir, 'stderr.log'),
      ...(timeoutMs !== null ? { timeoutMs } : {}),
    });
  }

  async normalize(
    result: RuntimeResult,
    context: NormalizationContext,
  ): Promise<NormalizedTraceFragment> {
    const durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();

    let usage: Record<string, number | null> = {};
    const warnings: string[] = [];
    try {
      const stdout = await readFile(result.stdoutPath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        warnings.push('claude-code: stdout was not valid JSON — usage unobserved');
        parsed = undefined;
      }
      if (parsed !== undefined) {
        if (typeof parsed === 'object' && parsed !== null) {
          const obj = parsed as Record<string, unknown>;
          const usageRaw = obj['usage'];
          if (typeof usageRaw === 'object' && usageRaw !== null) {
            const u = usageRaw as Record<string, unknown>;
            const pick = (key: string): number | null => {
              const v = u[key];
              return typeof v === 'number' ? v : null;
            };
            usage = {
              input_tokens: pick('input_tokens'),
              output_tokens: pick('output_tokens'),
              cache_creation_input_tokens: pick('cache_creation_input_tokens'),
              cache_read_input_tokens: pick('cache_read_input_tokens'),
            };
          } else {
            warnings.push('claude-code: stdout JSON had no usage field — usage unobserved');
          }
        } else {
          warnings.push('claude-code: stdout JSON was not an object — usage unobserved');
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Missing stdout is expected for killed/timed-out runs; warn only on normal exit
        if (result.exitCode === 0 && result.signal === null && !result.timedOut) {
          warnings.push('claude-code: stdout absent after normal exit — usage unobserved');
        }
      } else {
        warnings.push(
          `claude-code: stdout unreadable (${err instanceof Error ? err.message : String(err)}) — usage unobserved`,
        );
      }
    }

    return {
      runtime: { id: RUNTIME_ID, version: context.runtimeVersion },
      model: { requested: '', resolved: null },
      execution: { exitCode: result.exitCode, durationMs },
      usage,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
