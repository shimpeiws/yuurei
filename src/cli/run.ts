import { join } from 'node:path';
import { findYuureiDir } from '../config/discovery.js';
import { loadYuureiConfig } from '../config/yuurei-config.js';
import type { YuureiConfig } from '../config/schema.js';
import { loadProfile } from '../profile/loader.js';
import { runPipeline } from '../run/pipeline.js';
import { MAX_TIMEOUT_MS } from '../runtime/exec.js';
import { getRuntime } from '../runtime/registry.js';
import { isPathWithin } from '../util/fs.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import { exitCodeForSignal } from '../run/signals.js';
import { packageVersion } from '../version.js';
import type { RunDefinition } from '../trace/schema.js';
import type { Logger } from '../util/logger.js';
import type { IsolationStrategy } from '../isolation/types.js';

const ISOLATION_STRATEGIES: readonly IsolationStrategy[] = ['level0', 'level1'];
const DEFAULT_ISOLATION_STRATEGY: IsolationStrategy = 'level1';

function isIsolationStrategy(value: string): value is IsolationStrategy {
  return (ISOLATION_STRATEGIES as readonly string[]).includes(value);
}

export interface RunOptions {
  runName: string | undefined;
  profile: string | undefined;
  task: string | undefined;
  keep: boolean | undefined;
  model: string | undefined;
  /** Milliseconds before the runtime process is sent SIGTERM. undefined = no timeout. */
  timeoutMs: number | undefined;
  /** Isolation strategy (design doc §9.3): 'level0' or 'level1'. Defaults to 'level1'. */
  isolation: string | undefined;
  /**
   * Opt-in, experimental: bridge the real ~/.codex/auth.json into the
   * isolated CODEX_HOME (ignored for other runtimes). Off by default because
   * that file can carry a rotating OAuth token pair — see the Codex
   * adapter's bridgeCodexAuthFile doc comment. The supported v0.3 auth path
   * is an explicitly-set CODEX_API_KEY or OPENAI_API_KEY, forwarded
   * unconditionally.
   */
  bridgeCodexAuthFile: boolean | undefined;
  /**
   * Opt-in, experimental: bridge the real OpenCode `auth.json` into the
   * isolated data dir (ignored for other runtimes). Off by default because
   * that file can carry a rotating OAuth token pair — see the OpenCode
   * adapter's bridgeOpenCodeAuthFile doc comment. The supported path is an
   * explicitly-set provider API key, forwarded from the environment.
   */
  bridgeOpenCodeAuthFile: boolean | undefined;
}

const YUUREI_VERSION = packageVersion;

export async function runRun(cwd: string, options: RunOptions, logger: Logger): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const config = await loadYuureiConfig(yuureiDir);

  let runEntry: YuureiConfig['runs'][string] | undefined;
  let profileName = options.profile;
  let taskPath = options.task;

  if (options.runName) {
    runEntry = config.runs[options.runName];
    if (!runEntry) {
      throw new YuureiError(`unknown run: ${options.runName}`, EXIT_CODES.CONFIG_ERROR);
    }
    if (options.profile !== undefined || options.task !== undefined) {
      throw new YuureiError(
        `run '${options.runName}' names its own profile and task; --profile/--task cannot be combined with a run name`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    profileName = runEntry.profile;
    taskPath = join(yuureiDir, runEntry.task);
    if (!(await isPathWithin(yuureiDir, taskPath))) {
      throw new YuureiError(
        `task path escapes the .yuurei directory: ${runEntry.task}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
  }

  if (!profileName || !taskPath) {
    throw new YuureiError(
      'either a run name or both --profile and --task are required',
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  // Per field, CLI first: the flag if given, else the run definition's entry,
  // else the default (ADR-0013). `cli_overrides` records which parameter
  // fields the CLI supplied, so one trace answers "was anything supplied
  // outside the definition?" — field names only, never values.
  const cliOverrides: string[] = [];

  const requestedModel = options.model ?? runEntry?.model ?? '';
  if (options.model !== undefined) cliOverrides.push('model');

  const timeoutMs = options.timeoutMs ?? runEntry?.timeout ?? null;
  if (options.timeoutMs !== undefined) cliOverrides.push('timeout');
  if (
    timeoutMs !== null &&
    !(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)
  ) {
    throw new YuureiError(
      `timeout must be a finite number of milliseconds between 1 and ${MAX_TIMEOUT_MS}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  const isolationRaw = options.isolation ?? runEntry?.isolation ?? DEFAULT_ISOLATION_STRATEGY;
  if (options.isolation !== undefined) cliOverrides.push('isolation');
  if (!isIsolationStrategy(isolationRaw)) {
    throw new YuureiError(
      `isolation must be one of: ${ISOLATION_STRATEGIES.join(', ')}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  const isolationStrategy = isolationRaw;

  const profileEntry = config.profiles[profileName];
  if (!profileEntry) {
    throw new YuureiError(`unknown profile: ${profileName}`, EXIT_CODES.CONFIG_ERROR);
  }

  const profile = await loadProfile({
    name: profileName,
    runtime: profileEntry.runtime,
    sourceDir: join(yuureiDir, profileEntry.source),
  });

  const definition: RunDefinition = {
    run: options.runName ?? null,
    cli_overrides: cliOverrides,
  };

  const result = await runPipeline({
    runtimeId: profile.runtime,
    requestedModel,
    profile,
    taskPath,
    yuureiVersion: YUUREI_VERSION,
    yuureiDir,
    isolationStrategy,
    keep: options.keep ?? false,
    timeoutMs,
    executionOptions: {
      bridge_codex_auth_file: options.bridgeCodexAuthFile ?? false,
      bridge_opencode_auth_file: options.bridgeOpenCodeAuthFile ?? false,
    },
    definition,
    onWarning: (message) => logger.warn(message),
  });

  logger.info(`run ${result.runId} finished`, {
    exitCode: result.trace.execution.exit_code,
    signal: result.trace.execution.signal,
    runDir: result.runDir,
  });

  if (result.trace.execution.signal !== null) {
    process.exitCode = exitCodeForSignal(result.trace.execution.signal);
  }

  // Surface auth guidance on failure without exposing runtime stdout/stderr
  // (§10.2). Only for a numeric non-zero exit code — a signal-terminated run
  // (exit_code null) is covered by the signal exit-code propagation above.
  if (
    typeof result.trace.execution.exit_code === 'number' &&
    result.trace.execution.exit_code !== 0
  ) {
    const detection = await getRuntime(profile.runtime).detect();
    if (
      detection.installed &&
      detection.authUsable === false &&
      detection.authGuidance !== undefined
    ) {
      logger.warn(`${profile.runtime}: authentication required — next steps`, {
        authGuidance: detection.authGuidance,
      });
    }
  }
}
