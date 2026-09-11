import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listRuntimeIds } from '../runtime/registry.js';
import { isPathWithin, pathExists } from '../util/fs.js';
import { EXIT_CODES, YuureiError } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface InitOptions {
  /** Directory to scaffold, relative to `cwd`. Use `''` for the current directory. */
  directory: string;
  runtime: string;
  profile: string;
  task: string;
  /** Named run referencing the generated profile and task. Defaults to `task`. */
  run?: string;
  /** Emit the structured `InitReport` as the JSON output instead of the human report. */
  json?: boolean;
}

/** Structured report for `yuurei init`, emitted on stdout when `--json` is set. */
export interface InitReport {
  targetDir: string;
  /** False when the target was already a matching scaffold, so nothing was written. */
  created: boolean;
  /** Paths written (or verified to already match), relative to `targetDir`. */
  scaffoldPaths: string[];
  profile: string;
  task: string;
  run: string;
}

/** One generated file, `relPath` relative to the project root (starts with `.yuurei/`). */
interface ScaffoldFile {
  relPath: string;
  content: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateName(value: string, what: string): void {
  if (!NAME_PATTERN.test(value)) {
    throw new YuureiError(
      `invalid ${what} "${value}": use letters, digits, ".", "_" and "-", starting with a letter or digit`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
}

const DEFAULT_TASK_PROMPT =
  'Reply with "Hello from yuurei." Do not read or write any files or run commands.';

function scaffoldFiles(options: InitOptions): ScaffoldFile[] {
  const { runtime, profile, task } = options;
  const run = options.run ?? task;
  return [
    {
      relPath: '.yuurei/yuurei.yaml',
      content: [
        'version: 1',
        '',
        'profiles:',
        `  ${profile}:`,
        `    runtime: ${runtime}`,
        `    source: ./profiles/${profile}`,
        '',
        'runs:',
        `  ${run}:`,
        `    profile: ${profile}`,
        `    task: ./tasks/${task}.md`,
        '',
      ].join('\n'),
    },
    {
      relPath: `.yuurei/profiles/${profile}/profile.yaml`,
      content: [
        `runtime: ${runtime}`,
        `description: ${profile} profile scaffolded by yuurei init.`,
        '',
      ].join('\n'),
    },
    {
      relPath: `.yuurei/profiles/${profile}/config/.gitkeep`,
      content: '',
    },
    {
      relPath: `.yuurei/tasks/${task}.md`,
      content: `${DEFAULT_TASK_PROMPT}\n`,
    },
  ];
}

function displayPaths(options: InitOptions): string[] {
  const { profile, task } = options;
  return [
    '.yuurei/yuurei.yaml',
    `.yuurei/profiles/${profile}/profile.yaml`,
    `.yuurei/profiles/${profile}/config/.gitkeep`,
    `.yuurei/tasks/${task}.md`,
  ];
}

function buildInitReport(targetDir: string, options: InitOptions, created: boolean): InitReport {
  return {
    targetDir,
    created,
    scaffoldPaths: displayPaths(options),
    profile: options.profile,
    task: options.task,
    run: options.run ?? options.task,
  };
}

function printInitReport(report: InitReport, options: InitOptions, logger: Logger): void {
  if (options.json) {
    logger.info('init', { ...report });
    return;
  }
  logger.info(
    report.created
      ? `scaffolded project at ${report.targetDir}`
      : `project already scaffolded at ${report.targetDir}`,
  );
  for (const pathName of report.scaffoldPaths) {
    logger.info(pathName);
  }
  logger.info(
    `run "${report.run}" resolves to profile "${report.profile}" and task "${report.task}"`,
  );
  logger.info('next commands:');
  logger.info('  yuurei profile list');
  logger.info(`  yuurei inspect ${report.profile}`);
  logger.info(`  yuurei run ${report.run}`);
}

/**
 * `yuurei init` — scaffolds a minimal runnable project (issue #105). Never
 * overwrites an existing file: a preflight compares every planned file
 * against what is on disk and aborts before writing when any differ. Writes
 * stage into a sibling temp directory and rename into place, so an
 * unexpected failure cannot leave a partial scaffold (§2.3 fail-safe).
 */
export async function runInit(cwd: string, options: InitOptions, logger: Logger): Promise<void> {
  const targetDir = join(cwd, options.directory);
  const runtimeIds = listRuntimeIds();
  if (!runtimeIds.includes(options.runtime)) {
    throw new YuureiError(
      `unknown runtime "${options.runtime}": must be one of ${runtimeIds.join(', ')}`,
      EXIT_CODES.RUNTIME_UNSUPPORTED,
    );
  }
  validateName(options.profile, 'profile name');
  validateName(options.task, 'task name');
  if (options.run !== undefined) validateName(options.run, 'run name');

  const planned = scaffoldFiles(options);
  const yuureiDir = join(targetDir, '.yuurei');
  for (const file of planned) {
    const absPath = join(targetDir, file.relPath);
    if (!(await isPathWithin(targetDir, absPath))) {
      throw new YuureiError(
        `refusing to scaffold ${file.relPath}: escapes target directory ${targetDir}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
  }

  await mkdir(targetDir, { recursive: true });

  if (await pathExists(yuureiDir)) {
    const conflicts: string[] = [];
    for (const file of planned) {
      const existing = await readFile(join(targetDir, file.relPath), 'utf8').catch(() => null);
      if (existing !== file.content) conflicts.push(file.relPath);
    }
    if (conflicts.length > 0) {
      throw new YuureiError(
        `refusing to overwrite existing files: ${conflicts.join(', ')}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    printInitReport(buildInitReport(targetDir, options, false), options, logger);
    return;
  }

  const stagingDir = await mkdtemp(join(targetDir, '.yuurei-init-'));
  try {
    for (const file of planned) {
      const realPath = join(stagingDir, file.relPath);
      await mkdir(dirname(realPath), { recursive: true });
      await writeFile(realPath, file.content, 'utf8');
    }
    await rename(join(stagingDir, '.yuurei'), yuureiDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  printInitReport(buildInitReport(targetDir, options, true), options, logger);
}
