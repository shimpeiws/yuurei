import { join } from 'node:path';
import { findYuureiDir } from '../config/discovery.js';
import { loadYuureiConfig } from '../config/yuurei-config.js';
import { loadProfile } from '../profile/loader.js';
import { runPipeline } from '../run/pipeline.js';
import { isPathWithin } from '../util/fs.js';
import { YuureiError, EXIT_CODES } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface RunOptions {
  runName: string | undefined;
  profile: string | undefined;
  task: string | undefined;
  keep: boolean | undefined;
  model: string | undefined;
  /**
   * Opt-in, experimental: bridge the real ~/.codex/auth.json into the
   * isolated CODEX_HOME (ignored for other runtimes). Off by default because
   * that file can carry a rotating OAuth token pair — see the Codex
   * adapter's bridgeCodexAuthFile doc comment. The supported v0.3 auth path
   * is an explicitly-set OPENAI_API_KEY, forwarded unconditionally.
   */
  bridgeCodexAuthFile: boolean | undefined;
}

const YUUREI_VERSION = '0.0.1';

export async function runRun(cwd: string, options: RunOptions, logger: Logger): Promise<void> {
  const yuureiDir = await findYuureiDir(cwd);
  if (!yuureiDir) {
    throw new YuureiError('no .yuurei/ directory found', EXIT_CODES.CONFIG_ERROR);
  }

  const config = await loadYuureiConfig(yuureiDir);

  let profileName = options.profile;
  let taskPath = options.task;

  if (options.runName) {
    const runEntry = config.runs[options.runName];
    if (!runEntry) {
      throw new YuureiError(`unknown run: ${options.runName}`, EXIT_CODES.CONFIG_ERROR);
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

  const profileEntry = config.profiles[profileName];
  if (!profileEntry) {
    throw new YuureiError(`unknown profile: ${profileName}`, EXIT_CODES.CONFIG_ERROR);
  }

  const profile = await loadProfile({
    name: profileName,
    runtime: profileEntry.runtime,
    sourceDir: join(yuureiDir, profileEntry.source),
  });

  const result = await runPipeline({
    runtimeId: profile.runtime,
    requestedModel: options.model ?? '',
    profile,
    taskPath,
    yuureiVersion: YUUREI_VERSION,
    yuureiDir,
    isolationStrategy: 'level1',
    keep: options.keep ?? false,
    executionOptions: { bridgeCodexAuthFile: options.bridgeCodexAuthFile ?? false },
  });

  for (const warning of result.warnings) {
    logger.warn(warning);
  }

  logger.info(`run ${result.runId} finished`, {
    exitCode: result.trace.execution.exit_code,
    runDir: result.runDir,
  });
}
