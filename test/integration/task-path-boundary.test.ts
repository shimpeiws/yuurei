import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, YuureiError } from '../../src/cli/exit-codes.js';
import { runRun, type RunOptions } from '../../src/cli/run.js';
import { pathExists } from '../../src/util/fs.js';
import type { Logger } from '../../src/util/logger.js';

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function baseOptions(overrides: Partial<RunOptions>): RunOptions {
  return {
    runName: undefined,
    profile: 'does-not-exist',
    task: 'does-not-exist.md',
    keep: undefined,
    model: undefined,
    timeoutMs: undefined,
    isolation: undefined,
    bridgeCodexAuthFile: undefined,
    ...overrides,
  };
}

describe('task path trust boundary', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'yuurei-task-boundary-test-'));
    await mkdir(join(workDir, '.yuurei'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('accepts a direct --task path outside .yuurei (explicit operator choice)', async () => {
    await writeFile(
      join(workDir, '.yuurei', 'yuurei.yaml'),
      'version: 1\nprofiles: {}\nruns: {}\n',
      'utf8',
    );

    const run = runRun(
      workDir,
      baseOptions({ task: join(tmpdir(), 'outside-task.md') }),
      noopLogger,
    );

    // Passes path validation and fails later at profile lookup — proving the
    // external path was accepted, not blocked.
    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(run).rejects.toThrow(/unknown profile: does-not-exist/);
  });

  it('rejects a named-run task that escapes .yuurei before the runtime starts', async () => {
    await writeFile(
      join(workDir, '.yuurei', 'yuurei.yaml'),
      [
        'version: 1',
        'profiles: {}',
        'runs:',
        '  escape:',
        '    profile: does-not-exist',
        '    task: ../escape.md',
      ].join('\n') + '\n',
      'utf8',
    );

    const run = runRun(workDir, baseOptions({ runName: 'escape' }), noopLogger);

    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(run).rejects.toThrow(/task path escapes the \.yuurei directory/);

    // No run directory or partial trace was created before the rejection.
    const runsDir = join(workDir, '.yuurei', 'runs');
    if (await pathExists(runsDir)) {
      expect(await readdir(runsDir)).toHaveLength(0);
    }
  });

  it('accepts a named-run task inside .yuurei and proceeds past containment to the profile check', async () => {
    await mkdir(join(workDir, '.yuurei', 'tasks'), { recursive: true });
    await writeFile(join(workDir, '.yuurei', 'tasks', 'inside.md'), '# Task\n', 'utf8');
    await writeFile(
      join(workDir, '.yuurei', 'yuurei.yaml'),
      [
        'version: 1',
        'profiles: {}',
        'runs:',
        '  ok:',
        '    profile: does-not-exist',
        '    task: tasks/inside.md',
      ].join('\n') + '\n',
      'utf8',
    );

    const run = runRun(workDir, baseOptions({ runName: 'ok' }), noopLogger);

    // Passes containment check and fails later at profile lookup — confirming
    // containment is not over-broad.
    await expect(run).rejects.toBeInstanceOf(YuureiError);
    await expect(run).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    await expect(run).rejects.toThrow(/unknown profile: does-not-exist/);
  });
});
