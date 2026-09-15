import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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
  RegisterCredentialPath,
  Runtime,
  RuntimeDetection,
  RuntimeResult,
} from '../types.js';
import { pathExists, writeFileTree } from '../../util/fs.js';
import { buildOpenCodeArgs } from './args.js';
import { assertNoOpenCodeFileReferencesEscape } from './config-guard.js';
import {
  bridgeOpenCodeApiKeys,
  bridgeOpenCodeAuthFile,
  wantsOpenCodeAuthFileBridge,
} from './auth.js';
import { openCodeConfigDir, openCodeDataDir, openCodeEnv, realOpenCodeDataDir } from './paths.js';

const RUNTIME_ID = 'opencode';
const COMMAND = 'opencode';
const MIN_SUPPORTED_VERSION: [number, number, number] = [1, 18, 0];

const OPENCODE_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
] as const;

/** Usage metric -> path into a `step-finish` part. */
const USAGE_METRIC_PATHS: Record<string, readonly string[]> = {
  input_tokens: ['tokens', 'input'],
  output_tokens: ['tokens', 'output'],
  reasoning_output_tokens: ['tokens', 'reasoning'],
  cache_read_input_tokens: ['tokens', 'cache', 'read'],
  cache_write_input_tokens: ['tokens', 'cache', 'write'],
  // OpenCode reports cost in USD per step. v0.3's CostModel is a no-op, so the
  // observed value is kept here rather than silently dropped (design doc §20.7).
  cost_usd: ['cost'],
};

/**
 * Reads a nested field, distinguishing "absent" from "present but not a
 * number" so normalization can report *why* a metric was unobserved.
 */
function pickField(value: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

export class OpenCodeRuntime implements Runtime {
  id(): string {
    return RUNTIME_ID;
  }

  async detect(): Promise<RuntimeDetection> {
    const detection = await detectViaVersionFlag(COMMAND);
    const hasEnvKey = OPENCODE_PROVIDER_ENV_KEYS.some((key) => Boolean(process.env[key]));
    const hasAuthFile = await pathExists(join(realOpenCodeDataDir(homedir()), 'auth.json'));
    // OpenCode can run unauthenticated via a free default provider, so this
    // reports credential availability, not whether a run is possible.
    const authUsable = detection.installed && (hasEnvKey || hasAuthFile);
    return {
      ...detection,
      versionSupported: isVersionAtLeast(detection.version, MIN_SUPPORTED_VERSION),
      authUsable,
      ...(detection.installed && authUsable === false
        ? {
            authGuidance:
              'No OpenCode credential was found. OpenCode can still run with its free default provider; to use a specific provider, run `opencode auth login`, or export a supported provider API key (for example ANTHROPIC_API_KEY or OPENROUTER_API_KEY) in this shell and re-run `yuurei doctor`. ' +
              'A shell export applies only to that shell and its child processes; do not persist the key in a profile, task, or committed file. ' +
              'Verify the variable is set without printing its value: [ -n "$OPENROUTER_API_KEY" ] && echo present || echo absent',
          }
        : {}),
    };
  }

  async prepare(
    cell: ResolvedCell,
    isolation: IsolationContext,
    registerCredentialPath: RegisterCredentialPath,
  ): Promise<PreparedRun> {
    const configRoot = configRootOf(isolation);
    const env = { ...isolation.env, ...openCodeEnv(configRoot) };
    // Never self-update, never read a project config found by walking up from
    // the cell's cwd, and never import the operator's ~/.claude or ~/.agents
    // skills (matters under level0, where HOME is real) — design doc §20.3.
    env['OPENCODE_DISABLE_AUTOUPDATE'] = '1';
    env['OPENCODE_DISABLE_PROJECT_CONFIG'] = '1';
    env['OPENCODE_DISABLE_EXTERNAL_SKILLS'] = '1';
    const configDir = openCodeConfigDir(configRoot);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    // Reject out-of-cell {file:...} references before anything is written
    // (§20.5). `homeDir` is the HOME OpenCode will actually see, so `~`
    // expands correctly (isolated home under level1, real home under level0).
    // If HOME is absent, OpenCode would resolve `~` through the passwd entry,
    // so the guard refuses `~` references rather than guessing a path.
    const homeDir = isolation.env['HOME'] ?? null;
    await assertNoOpenCodeFileReferencesEscape(
      configDir,
      cell.resolvedProfile.content.configFiles,
      homeDir,
      isolation.rootDir,
    );
    await writeFileTree(configDir, cell.resolvedProfile.content.configFiles);
    const credentialValuesToRedact = bridgeOpenCodeApiKeys(env);

    if (wantsOpenCodeAuthFileBridge(cell.executionOptions)) {
      const dataDir = openCodeDataDir(configRoot);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      // Register the destination before the copy so a signal or throw between
      // the write and prepare()'s return still leaves it on the scrub list
      // (§9.2). Registering a path the copy never reaches is harmless.
      registerCredentialPath(join(dataDir, 'auth.json'));
      const secretValues = await bridgeOpenCodeAuthFile(dataDir);
      credentialValuesToRedact.push(...secretValues);
    }

    const detection = await this.detect();

    return {
      runtimeId: RUNTIME_ID,
      command: COMMAND,
      args: buildOpenCodeArgs(cell),
      env,
      cwd: isolation.workspaceDir,
      isolation,
      cell,
      runtimeVersion: detection.version,
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

    const usage: Record<string, number | null> = {};
    const diagnostics: string[] = [];
    try {
      const stdout = await readFile(result.stdoutPath, 'utf8');
      const metrics: Record<string, { sum: number; problems: string[] }> = {};
      const malformedLines: number[] = [];
      let sawError = false;
      let sawStepFinish = false;

      for (const [index, line] of stdout.split('\n').entries()) {
        const lineNumber = index + 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          malformedLines.push(lineNumber);
          continue;
        }
        if (typeof event !== 'object' || event === null) {
          malformedLines.push(lineNumber);
          continue;
        }
        const obj = event as Record<string, unknown>;
        if (obj['type'] === 'error') {
          // Record only that an error was observed. The error body is runtime
          // output and may carry an arbitrary secret, so it is never persisted
          // into the durable diagnostics (redactSecrets does not guarantee
          // removing an unknown value).
          sawError = true;
          continue;
        }
        if (obj['type'] !== 'step_finish') continue;
        const part = obj['part'];
        if (
          typeof part !== 'object' ||
          part === null ||
          (part as Record<string, unknown>)['type'] !== 'step-finish'
        ) {
          // A step_finish event with a malformed payload is a contract break,
          // not a benign event to skip silently.
          malformedLines.push(lineNumber);
          continue;
        }
        sawStepFinish = true;
        for (const [key, path] of Object.entries(USAGE_METRIC_PATHS)) {
          const entry = (metrics[key] ??= { sum: 0, problems: [] });
          const field = pickField(part, path);
          if (!field.found) {
            entry.problems.push(`line ${lineNumber}: absent`);
          } else if (typeof field.value !== 'number') {
            entry.problems.push(`line ${lineNumber}: wrong type (${typeof field.value})`);
          } else if (!Number.isFinite(field.value)) {
            entry.problems.push(`line ${lineNumber}: non-finite`);
          } else if (field.value < 0) {
            entry.problems.push(`line ${lineNumber}: negative`);
          } else {
            entry.sum += field.value;
          }
        }
      }

      if (malformedLines.length > 0) {
        const shown = malformedLines.slice(0, 10).join(', ');
        const more = malformedLines.length > 10 ? ', …' : '';
        diagnostics.push(
          `opencode: ${malformedLines.length} unparseable JSONL line(s) skipped (lines ${shown}${more})`,
        );
      }
      if (sawError) {
        diagnostics.push('opencode: session error reported (details omitted)');
      }

      if (!sawStepFinish) {
        diagnostics.push('opencode: no step_finish event found in stdout — usage unobserved');
      } else {
        for (const key of Object.keys(USAGE_METRIC_PATHS)) {
          const entry = metrics[key];
          usage[key] = entry !== undefined && entry.problems.length === 0 ? entry.sum : null;
        }
        for (const [key, entry] of Object.entries(metrics)) {
          if (entry.problems.length === 0) continue;
          const shown = entry.problems.slice(0, 3).join('; ');
          const more = entry.problems.length > 3 ? '; …' : '';
          diagnostics.push(`opencode: ${key} unobserved (${shown}${more})`);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Missing stdout is expected for killed/timed-out runs; note it only on
        // a normal exit.
        if (result.exitCode === 0 && result.signal === null && !result.timedOut) {
          diagnostics.push('opencode: stdout absent after normal exit — usage unobserved');
        }
      } else {
        // Fixed string only: `err.message` can carry a filesystem path, and
        // diagnostics are contractually fixed-string (§6.3, §20.7).
        diagnostics.push('opencode: stdout unreadable — usage unobserved');
      }
    }

    return {
      runtime: { id: RUNTIME_ID, version: context.runtimeVersion },
      model: { requested: '', resolved: null, resolvedReason: 'unobserved' },
      execution: { exitCode: result.exitCode, signal: result.signal, durationMs },
      usage,
      // Durable notes only. `warnings` is a separate, operator-facing channel
      // (§6.3); normalization issues here are diagnostic, not actionable
      // warnings, so they are not mirrored into it.
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }
}
