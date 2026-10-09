#!/usr/bin/env node
import cac from 'cac';
import { runClean } from './cli/clean.js';
import { printDoctorReport, runDoctor } from './cli/doctor.js';
import { runInit } from './cli/init.js';
import { runInspect } from './cli/inspect.js';
import { ERROR_CODES, EXIT_CODES, YuureiError } from './cli/exit-codes.js';
import { loggerForFlags } from './cli/output.js';
import { runProfileList } from './cli/profile-list.js';
import { runRun } from './cli/run.js';
import { runRuns } from './cli/runs.js';
import { runTraceShow } from './cli/trace-show.js';
import { packageVersion } from './version.js';

const cli = cac('yuurei');

function reportFailure(error: unknown, json: boolean): void {
  const logger = loggerForFlags({ json });
  const failure =
    error instanceof YuureiError
      ? { message: error.message, code: error.code, exitCode: error.exitCode }
      : {
          message: error instanceof Error ? error.message : String(error),
          code: ERROR_CODES.INTERNAL_ERROR,
          exitCode: EXIT_CODES.RUNTIME_EXECUTION_FAILED,
        };
  // The stable code and the exit code ride only on the --json line
  // (contract Section A); the human line stays the plain message.
  if (json) {
    logger.error(failure.message, { code: failure.code, exit_code: failure.exitCode });
  } else {
    logger.error(failure.message);
  }
  process.exitCode = failure.exitCode;
}

function withErrorHandling<Args extends [...unknown[], { json?: boolean }]>(
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await action(...args);
    } catch (error) {
      const flags = args[args.length - 1] as { json?: boolean };
      reportFailure(error, flags.json ?? false);
    }
  };
}

cli
  .command('doctor', 'Inspect the environment; never mutates it')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (flags: { json?: boolean }) => {
      const report = await runDoctor();
      printDoctorReport(report, loggerForFlags(flags), flags.json ? 'json' : 'human');
    }),
  );

cli
  .command('profile <action>', 'Manage profiles (only "list" is supported)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (action: string, flags: { json?: boolean }) => {
      if (action !== 'list') {
        throw new YuureiError(
          `unknown profile action: ${action}`,
          EXIT_CODES.CONFIG_ERROR,
          ERROR_CODES.INVALID_INPUT,
        );
      }
      await runProfileList(process.cwd(), loggerForFlags(flags));
    }),
  );

cli
  .command('inspect <profile-name>', 'Resolve a profile without running anything')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (profileName: string, flags: { json?: boolean }) => {
      await runInspect(process.cwd(), profileName, loggerForFlags(flags));
    }),
  );

cli
  .command('clean', 'Remove orphaned isolation temp directories')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (flags: { json?: boolean }) => {
      await runClean(loggerForFlags(flags));
    }),
  );

cli
  .command('init [directory]', 'Scaffold a new project for a first run')
  .option('--runtime <runtime>', 'Runtime to scaffold for (default: claude-code)')
  .option('--profile <name>', 'Profile name (default: claude-basic)')
  .option('--task <name>', 'Task name (default: hello)')
  .option('--run <name>', 'Named run referencing the profile and task (default: the task name)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(
      async (
        directory: string | undefined,
        flags: {
          runtime?: string;
          profile?: string;
          task?: string;
          run?: string;
          json?: boolean;
        },
      ) => {
        await runInit(
          process.cwd(),
          {
            directory: directory ?? '',
            runtime: flags.runtime ?? 'claude-code',
            profile: flags.profile ?? 'claude-basic',
            task: flags.task ?? 'hello',
            ...(flags.run !== undefined ? { run: flags.run } : {}),
            json: flags.json ?? false,
          },
          loggerForFlags(flags),
        );
      },
    ),
  );

cli
  .command('run [run-name]', 'Execute a run')
  .option('--profile <profile>', 'Profile name (used with --task instead of a run name)')
  .option('--task <task>', 'Task file path (used with --profile instead of a run name)')
  .option('--model <model>', 'Requested model')
  .option('--keep', 'Keep the isolated workspace for debugging')
  .option(
    '--timeout <ms>',
    'Kill the runtime process after this many milliseconds (default: no timeout)',
  )
  .option('--isolation <level>', 'Isolation strategy: level0 or level1 (default: level1)')
  .option(
    '--seed-repo <dir>',
    'Experimental: seed the cell workspace from this local Git repository root (clean worktree required)',
  )
  .option(
    '--bridge-codex-auth-file',
    'Experimental: bridge the real ~/.codex/auth.json into the isolated run (Codex only, off by default)',
  )
  .option(
    '--bridge-opencode-auth-file',
    'Experimental: bridge the real OpenCode auth.json into the isolated run (OpenCode only, off by default)',
  )
  .option('--observe', 'Experimental: enable pre-run observation phase (#210)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(
      async (
        runName: string | undefined,
        flags: {
          profile?: string;
          task?: string;
          model?: string;
          keep?: boolean;
          timeout?: string;
          isolation?: string;
          bridgeCodexAuthFile?: boolean;
          bridgeOpenCodeAuthFile?: boolean;
          seedRepo?: string;
          observe?: boolean;
          json?: boolean;
        },
      ) => {
        await runRun(
          process.cwd(),
          {
            runName,
            profile: flags.profile,
            task: flags.task,
            model: flags.model,
            keep: flags.keep,
            timeoutMs: flags.timeout !== undefined ? Number(flags.timeout) : undefined,
            isolation: flags.isolation,
            bridgeCodexAuthFile: flags.bridgeCodexAuthFile,
            bridgeOpenCodeAuthFile: flags.bridgeOpenCodeAuthFile,
            seedRepo: flags.seedRepo,
            observe: flags.observe,
          },
          loggerForFlags(flags),
        );
      },
    ),
  );

cli
  .command('runs', 'List the runs under .yuurei/runs/')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (flags: { json?: boolean }) => {
      await runRuns(process.cwd(), loggerForFlags(flags), flags.json ?? false);
    }),
  );

cli
  .command('trace <action> <run-id>', 'Inspect traces (only "show" is supported)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (action: string, runId: string, flags: { json?: boolean }) => {
      if (action !== 'show') {
        throw new YuureiError(
          `unknown trace action: ${action}`,
          EXIT_CODES.CONFIG_ERROR,
          ERROR_CODES.INVALID_INPUT,
        );
      }
      await runTraceShow(process.cwd(), runId, loggerForFlags(flags), flags.json ?? false);
    }),
  );

cli.help();
cli.version(packageVersion);
try {
  cli.parse();
} catch (error) {
  // `cli.parse()` runs outside the action wrappers above, so an invalid
  // invocation (unknown option, missing required argument, unused argument)
  // would otherwise escape as a raw stack trace with no JSON envelope. Those
  // parser rejections are all invalid CLI input; route them through the same
  // report so a `--json` consumer still gets a stable `code` and `exit_code`.
  // `--json` comes straight from argv because parsing never handed it over.
  const json = process.argv.some((arg) => arg === '--json' || arg.startsWith('--json='));
  if (error instanceof Error && error.name === 'CACError') {
    reportFailure(
      new YuureiError(error.message, EXIT_CODES.CONFIG_ERROR, ERROR_CODES.INVALID_INPUT),
      json,
    );
  } else {
    reportFailure(error, json);
  }
}
